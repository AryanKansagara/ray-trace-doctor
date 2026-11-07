"""Run small Ray jobs and save their real `ray.timeline()` output.

The workloads are simulated (sleeps stand in for model work) and GPUs are logical
(`ray.init(num_gpus=N)`), but every span in the output is written by Ray itself.

    python scripts/gen_traces.py gpu_starved out.json
"""
import random
import sys
import time

import numpy as np
import ray


def gpu_pipeline(preprocess_concurrency):
    import ray.data

    def preprocess(batch):
        time.sleep(0.25)
        batch["pixels"] = np.zeros((len(batch["id"]), 256), dtype=np.float32)
        return batch

    class EmbedModel:
        def __call__(self, batch):
            time.sleep(0.06)
            return {"score": np.zeros(len(batch["pixels"]))}

    ray.init(num_cpus=12, num_gpus=4, include_dashboard=False, logging_level="ERROR")
    ds = (
        ray.data.range(3200, override_num_blocks=160)
        .map_batches(preprocess, batch_size=20, num_cpus=1, concurrency=preprocess_concurrency)
        .map_batches(EmbedModel, batch_size=20, num_gpus=1, concurrency=4)
    )
    ds.materialize()


def skew():
    @ray.remote
    def load_shard(i):
        time.sleep(0.05)
        return np.zeros(50_000, dtype=np.float32)

    @ray.remote
    def process_shard(shard, seconds):
        time.sleep(seconds)
        return shard[:10].sum()

    @ray.remote
    def merge(*parts):
        time.sleep(0.4)
        return sum(parts)

    ray.init(num_cpus=8, include_dashboard=False, logging_level="ERROR")
    rng = random.Random(7)
    shards = [load_shard.remote(i) for i in range(360)]
    work = []
    for i, s in enumerate(shards):
        secs = min(rng.lognormvariate(-2.0, 0.7), 1.2)
        if i % 70 == 13:  # a handful of pathological keys
            secs = rng.uniform(3.5, 6.0)
        work.append(process_shard.remote(s, secs))
    ray.get([merge.remote(*work[i : i + 60]) for i in range(0, len(work), 60)])


def small(batch):
    @ray.remote
    def score_row(n):
        s = 0
        for i in range(n):
            s += i * i
        return s

    ray.init(num_cpus=10, include_dashboard=False, logging_level="ERROR")
    rows, per_row = 6000, 4000
    ray.get([score_row.remote(per_row * batch) for _ in range(rows // batch)])


JOBS = {
    "gpu_starved": lambda: gpu_pipeline(2),
    "gpu_fixed": lambda: gpu_pipeline(10),
    "skew": skew,
    "small": lambda: small(1),
    "small_fixed": lambda: small(100),
}

if __name__ == "__main__":
    JOBS[sys.argv[1]]()
    time.sleep(4)  # task events reach the GCS on an interval
    ray.timeline(filename=sys.argv[2])
