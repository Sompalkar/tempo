/**
 * One small interface for "ask a model for structured JSON", with two
 * backends:
 *
 *   claude   the Claude Code CLI (`claude -p`). Runs on the user's existing
 *            Claude subscription. No API key. ~8s a call. DEFAULT.
 *   api      the Anthropic SDK. Needs ANTHROPIC_API_KEY. Faster, costs credits.
 *
 * The rest of tempo never knows which one it is talking to.
 *
 * Pick with TEMPO_LLM=claude|api. If unset: `api` when ANTHROPIC_API_KEY is
 * present, otherwise `claude`.
 */
import { spawn } from 'node:child_process';
import { z, type ZodType } from 'zod';

/**
 * Environment for a child `claude -p`.
 *
 * Strip the variables a parent Claude Code session leaves behind (they point
 * the child at the parent's auth and can 401), turn thinking off, and —
 * critically — tell tempo's own SessionEnd hook NOT to capture this child.
 * Without that last line the extractor's session ends, capture fires, spawns
 * another extractor, whose session ends, capture fires... 8,476 times on one
 * laptop before the usage limit stopped it. See JOURNAL, failure #17.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(base).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'ANTHROPIC_BASE_URL'),
  ) as NodeJS.ProcessEnv;
  env['MAX_THINKING_TOKENS'] = '0';
  env['DISABLE_THINKING'] = '1';
  env['TEMPO_CAPTURE'] = 'off';
  return env;
}

/** Run a command, feed it stdin, collect stdout. Rejects on non-zero exit or timeout. */
function run(cmd: string, args: string[], stdin: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else {
        // claude -p reports API problems (usage limit, auth) as JSON on
        // stdout, not stderr. Show whichever has the message.
        const stderr = Buffer.concat(err).toString('utf8').trim();
        const stdout = Buffer.concat(out).toString('utf8').trim();
        let msg = stderr;
        try {
          const j = JSON.parse(stdout) as { result?: string };
          if (j.result) msg = j.result;
        } catch {
          if (!msg) msg = stdout;
        }
        reject(new Error(`${cmd} exited ${code}: ${msg.slice(0, 300)}`));
      }
    });
    child.stdin.end(stdin);
  });
}

export interface StructuredRequest<T> {
  system: string;
  user: string;
  schema: ZodType<T>;
  maxTokens?: number;
}

export interface StructuredLLM {
  readonly name: string;
  /** Returns null when the model produced nothing usable. Throws on transport errors. */
  parse<T>(req: StructuredRequest<T>): Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Backend: Claude Code CLI
// ---------------------------------------------------------------------------

/**
 * `claude -p` with --json-schema gives us validated structured output on the
 * user's subscription. We turn every tool off and give it our own system
 * prompt so it behaves like a plain model call.
 */
export function claudeCliLLM(opts: { model?: string; timeoutMs?: number } = {}): StructuredLLM {
  const model = opts.model ?? 'haiku';
  const timeout = opts.timeoutMs ?? 120_000;
  return {
    name: `claude-cli:${model}`,
    async parse<T>(req: StructuredRequest<T>): Promise<T | null> {
      // zod stamps a draft-2020 "$schema" header; claude's validator only
      // knows draft-07 and rejects the whole schema over it. Drop the header.
      const { $schema: _ignored, ...schemaBody } = z.toJSONSchema(req.schema) as Record<string, unknown>;
      const schema = JSON.stringify(schemaBody);
      const args = [
        '-p',
        '--model', model,
        '--tools', '',
        '--output-format', 'json',
        '--json-schema', schema,
        '--system-prompt', req.system,
      ];
      const env = childEnv();
      const stdout = await run('claude', args, req.user, env, timeout);
      const out = JSON.parse(stdout) as { is_error?: boolean; structured_output?: unknown; result?: string };
      if (out.is_error) throw new Error(`claude -p failed: ${out.result ?? 'unknown error'}`);
      if (out.structured_output === undefined) return null;
      const parsed = req.schema.safeParse(out.structured_output);
      return parsed.success ? parsed.data : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Backend: Anthropic SDK
// ---------------------------------------------------------------------------

export function apiLLM(opts: { model?: string; client?: import('@anthropic-ai/sdk').default } = {}): StructuredLLM {
  const model = opts.model ?? 'claude-haiku-4-5';
  let client = opts.client;
  return {
    name: `api:${model}`,
    async parse<T>(req: StructuredRequest<T>): Promise<T | null> {
      if (!client) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        client = new Anthropic();
      }
      const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
      const response = await client.messages.parse({
        model,
        max_tokens: req.maxTokens ?? 8000,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: { format: zodOutputFormat(req.schema) },
      });
      return (response.parsed_output as T | null) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------

export function defaultLLM(): StructuredLLM {
  const choice = process.env['TEMPO_LLM'] ?? (process.env['ANTHROPIC_API_KEY'] ? 'api' : 'claude');
  if (choice === 'api') return apiLLM();
  if (choice === 'claude') return claudeCliLLM();
  throw new Error(`TEMPO_LLM must be "claude" or "api", got "${choice}"`);
}
