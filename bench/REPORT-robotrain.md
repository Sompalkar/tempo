# tempo report — RoboTrain, 10 sessions

Run on a Claude Pro subscription (`TEMPO_LLM=claude`), 171 chunks, then `tempo reconcile`.

```
facts stored ............ 1262
still current ........... 1248
superseded (changed) .... 14
confirmed by 2+ sources . 78
open conflicts .......... 9
auto-resolved ........... 14

Things that changed over time:
  design.theme.colors.green
    was: Green color token added to design system for marking architectural improvements.
    now: Color token --c-green is #2B8A3E (dark mode) and #63D68B (light mode)
  robotrain.architecture.diagram.mermaid-format
    was: System architecture diagram also available in Mermaid flowchart format alongside SVG version.
    now: Architecture diagram implemented in Mermaid flowchart format with color styling and subgraph grouping to show components and data flow.
  robotrain.backend.config.log-prune-interval
    was: LOG_PRUNE_INTERVAL_MINUTES: 60
    now: Old logs are pruned every 60 minutes.
  robotrain.backend.config.log-retention
    was: LOG_RETENTION_HOURS: 72
    now: Logs are retained for 72 hours.
  robotrain.backend.job-filters.search-field
    was: JobFilters now includes an optional search field for free-text job search
    now: JobFilters.search performs case-insensitive match across dataset, model type, base model and task type
  robotrain.backend.logging.httpx-noise
    was: httpx logging of Supabase polls accounts for 88% of all log lines; combined with worker heartbeat logs, ~93% of logs are noise
    now: httpx and httpcore logging held at WARNING level because they log per network call and worker polls every few seconds
  robotrain.backend.modal.functions.deployed
    was: Three Modal functions are deployed: train_a100, train_hf_a100, and train_custom_a100
    now: Six Modal training functions deployed: train_a100, train_h100, train_hf_a100, train_hf_h100, train_custom_a100, train_custom_h100
  robotrain.backend.queue.snapshot-structure
    was: Queue snapshot from db_service contains 'queued' and 'running' arrays with per-job position and starts_in timing
    now: Queue snapshot from db_service contains 'queued' and 'running' arrays, used to calculate positions and wait times.
  robotrain.backend.tests.count
    was: 62 tests pass in the preflight test suite.
    now: Test count is 63/63 (increased from 35).
  robotrain.backend.tests.count
    was: Test suite has 54 passing tests (35 existing + 19 new pricing-related tests).
    now: Test count is 63/63 (increased from 35).

Disagreements nobody has settled:
  robotrain.backend.queue.eta.default-job-duration
    A: DEFAULT_JOB_MINUTES is 30.0 minutes, assumed when a job has no estimate
    B: Queue ETA uses DEFAULT_JOB_MINUTES as fallback when a job has no estimated duration or an unusable estimate (zero, negative, non-numeric, or null).
  robotrain.backend.job-model.fields
    A: JobFilters includes status, search, gpu_type, date_from, date_to, sort_by, sort_order, limit, offset
    B: JobResponse model includes queue_position (optional int, 1-based place in line) and queue_wait_minutes (optional float, minutes until GPU available)
  robotrain.backend.queue-eta.module
    A: Queue position and wait-time estimation logic implemented as pure functions over plain dicts with no database or clock beyond what is passed in, allowing scheduling rule to be tested independently.
    B: New queue_eta module provides remaining_minutes() and schedule() helpers for queue calculations.
  robotrain.backend.logging.noisy-libraries
    A: Third-party libraries (httpx, httpcore, hpack, urllib3, botocore, modal-utils) log a line per network call and are silenced at INFO level to avoid drowning out application logs.
    B: NOISY_LIBRARIES held at WARNING log level
  robotrain.workflow.commit-size
    A: For small changes: 3-4 commits; for large: 5-6 commits.
    B: Small commits: three to six commits if large feature.
  robotrain.backend.worker-service.concurrency-gate
    A: Concurrency gate enforced before claiming jobs in _resume_orphaned_jobs()
    B: Concurrency gate checks before claiming new jobs.
  robotrain.backend.database.log-pruning
    A: Database service has delete_logs() and prune_old_logs() for retention management.
    B: prune_old_logs() removes logs older than retention period
  robotrain.backend.job-model.fields
    A: JobCreate/JobInDB/JobResponse includes base_model, task_type, training_script, script_command, script_source, output_model_id
    B: JobFilters includes status, search, gpu_type, date_from, date_to, sort_by, sort_order, limit, offset
  robotrain.backend.training.custom.implementation
    A: Custom training supports bring-your-own scripts (git clone or inline), streaming stdout, with dataset/base-model/token injected as environment variables.
    B: Train_custom_* functions are deployed via Modal after running modal deploy.
```

## Open disagreements

```
open  robotrain.backend.queue.eta.default-job-duration
   A  DEFAULT_JOB_MINUTES is 30.0 minutes, assumed when a job has no estimate
      session:a378cfd8 · a378cfd8-f565-4aab-962a-0022ea21389b#2
   B  Queue ETA uses DEFAULT_JOB_MINUTES as fallback when a job has no estimated duration or an unusable estimate (zero, negative, non-numeric, or null).
      session:e2cdc10e · e2cdc10e-51d5-4151-ad94-fa3e624ef525#5

open  robotrain.backend.job-model.fields
   A  JobFilters includes status, search, gpu_type, date_from, date_to, sort_by, sort_order, limit, offset
      session:47a79959 · 47a79959-367e-4870-820e-5a5efd18bd3e#2
   B  JobResponse model includes queue_position (optional int, 1-based place in line) and queue_wait_minutes (optional float, minutes until GPU available)
      session:e2cdc10e · e2cdc10e-51d5-4151-ad94-fa3e624ef525#4

open  robotrain.backend.queue-eta.module
   A  Queue position and wait-time estimation logic implemented as pure functions over plain dicts with no database or clock beyond what is passed in, allowing scheduling rule to be tested independently.
      session:e2cdc10e · e2cdc10e-51d5-4151-ad94-fa3e624ef525#2
   B  New queue_eta module provides remaining_minutes() and schedule() helpers for queue calculations.
      session:fa0165d1 · fa0165d1-2adb-4a39-9c11-cc72744a369e#3

open  robotrain.backend.logging.noisy-libraries
   A  Third-party libraries (httpx, httpcore, hpack, urllib3, botocore, modal-utils) log a line per network call and are silenced at INFO level to avoid drowning out application logs.
      session:084724cf · 084724cf-d8a9-48de-81c8-a2d16ca928da#56
   B  NOISY_LIBRARIES held at WARNING log level
      session:fa0165d1 · fa0165d1-2adb-4a39-9c11-cc72744a369e#0

open  robotrain.workflow.commit-size
   A  For small changes: 3-4 commits; for large: 5-6 commits.
      session:e2cdc10e · e2cdc10e-51d5-4151-ad94-fa3e624ef525#0
   B  Small commits: three to six commits if large feature.
      session:18567dbc · 18567dbc-7b56-42ae-8f4a-e1ef8df8ef8d#0

open  robotrain.backend.worker-service.concurrency-gate
   A  Concurrency gate enforced before claiming jobs in _resume_orphaned_jobs()
      session:fa0165d1 · fa0165d1-2adb-4a39-9c11-cc72744a369e#0
   B  Concurrency gate checks before claiming new jobs.
      session:18567dbc · 18567dbc-7b56-42ae-8f4a-e1ef8df8ef8d#0

open  robotrain.backend.database.log-pruning
   A  Database service has delete_logs() and prune_old_logs() for retention management.
      session:18567dbc · 18567dbc-7b56-42ae-8f4a-e1ef8df8ef8d#0
   B  prune_old_logs() removes logs older than retention period
      session:fcbe9a6c · fcbe9a6c-76e4-4ece-8568-3d366dcf76aa#0

open  robotrain.backend.job-model.fields
   A  JobCreate/JobInDB/JobResponse includes base_model, task_type, training_script, script_command, script_source, output_model_id
      session:99c31b53 · 99c31b53-799a-4156-9e88-4082112bc0b5#3
   B  JobFilters includes status, search, gpu_type, date_from, date_to, sort_by, sort_order, limit, offset
      session:47a79959 · 47a79959-367e-4870-820e-5a5efd18bd3e#2

open  robotrain.backend.training.custom.implementation
   A  Custom training supports bring-your-own scripts (git clone or inline), streaming stdout, with dataset/base-model/token injected as environment variables.
      session:99c31b53 · 99c31b53-799a-4156-9e88-4082112bc0b5#4
   B  Train_custom_* functions are deployed via Modal after running modal deploy.
      session:084724cf · 084724cf-d8a9-48de-81c8-a2d16ca928da#11

```
