# Ray Trace Doctor

Upload a saved `ray timeline` trace and find out where your job lost time: idle GPUs, starved stages, stragglers, tiny tasks. It works after the cluster is gone, because all it needs is the file.

Live: https://ray-trace-doctor.vercel.app

## The pain

Ray's forum keeps hearing about [idle workers holding GPU memory](https://discuss.ray.io/t/lots-of-ray-idle-proccess-occupy-gpu-memory/15263), [GPU actors idle with thousands of blocks queued](https://discuss.ray.io/t/ray-data-blocks-queued-but-can-not-be-processed/15135) and [slow tasks where the answer is "look at `ray timeline`"](https://discuss.ray.io/t/troubleshooting-slow-task-execution-in-ray-clusters/21241). The dashboard goes away with the head node. A saved trace doesn't, but a raw Chrome trace only shows you bars, not a diagnosis.

## Features

- **Streaming engine in a Web Worker.** Parses `.json` and `.json.gz` (native `DecompressionStream`) one event at a time into typed arrays. Reconstructs nodes, workers, actors and tasks, and reports anything unexpected.
- **Diagnoses with evidence.** GPU workers idle, stages starving each other, idle while work exists, stragglers (modified z-score), skew, deserialization, store_outputs, too-small tasks, serialized stages, barriers, utilization, a critical-path-style estimate. Each has lost worker-seconds, a labelled "if fixed" estimate and a specific change to make.
- **Explicit about inference.** A trace records what ran and when. It has no resources, dependencies or queue contents, so each card lists what was inferred. GPU attribution uses your mapping (or a name guess you can turn off).
- **Timeline.** Instanced WebGL2 (Canvas2D fallback) with level-of-detail aggregation, WASD navigation like Perfetto, and cards that jump to and light up the exact spans.
- **Charts.** Worker x time heatmap, utilization over time, flame summary by task name, duration distributions.
- **Compare two runs.** Per-task-type deltas, and what was estimated against what was measured.
- **Exports.** A single static HTML report and JSON. Aggregates only, no raw spans.
- **Private.** No backend. A Content-Security-Policy limits network requests to this site's static files. Share links hold settings only.

## Traces

`scripts/gen_traces.py` produced the samples in `public/samples` and they are real Ray 2.60 `ray.timeline()` output. The workloads are synthetic (sleeps and small loops on one machine) and the GPUs are logical (`ray.init(num_gpus=N)`). The stress test is generated in the browser, is fully synthetic, and says so. `src/engine/fixtures/format-derived-dashboard.json` comes from running Ray's own `chrome_tracing_dump` on hand-written task records.

## Run locally

```sh
npm install
npm run dev
npm test
npm run build
```
