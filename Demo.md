

cd ~/dev/glen
alias tempo='node ~/dev/glen/src/cli.ts'
export TEMPO_DB=~/.tempo/demo.db TEMPO_ORG=acme TEMPO_LLM=claude
rm -f ~/.tempo/demo.db ~/.tempo/demo.db-wal ~/.tempo/demo.db-shm






step - 0 


echo "For the record: staging is Postgres 16 at db-staging.internal, and deploys go through 'make ship'. Just say OK." \
  | claude -p




echo "What's our staging database host, and how do we deploy? One line." \
  | claude -p



step 1 —



echo "Use tempo_remember to store key 'deploy.command' with value 'make deploy'." \
  | TEMPO_WRITER=agent-alice claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember




echo "Use tempo_remember to store key 'deploy.command' with value './scripts/ship.sh'." \
  | TEMPO_WRITER=agent-bob claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember



echo "What is our deploy command? Check team memory first." \
  | TEMPO_WRITER=agent-carol claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_recall




Step - 2 

echo "tempo_remember: key 'refund.policy', value '30 days', validFrom '2026-03-01'. Then key 'refund.policy', value '14 days', validFrom '2026-06-01'." \
  | claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember



echo "A customer is disputing an April 2026 charge. What was our refund policy then, and what is it now?" \
  | claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_recall




Step - 3

TEMPO_ORG=som tempo report

