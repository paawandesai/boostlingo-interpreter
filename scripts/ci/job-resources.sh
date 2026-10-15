#!/bin/sh
# Prints this CI job's CPU and memory budget and its peak memory, read from the container's cgroup (v2, v1 fallback).
# Runs as the default after_script so every job log carries the numbers the CI report quotes.
cg=/sys/fs/cgroup
if [ -f "$cg/memory.max" ]; then
  limit=$(cat "$cg/memory.max"); peak=$(cat "$cg/memory.peak" 2>/dev/null || echo n/a); cpu=$(cat "$cg/cpu.max" 2>/dev/null || echo n/a)
elif [ -f "$cg/memory/memory.limit_in_bytes" ]; then
  limit=$(cat "$cg/memory/memory.limit_in_bytes"); peak=$(cat "$cg/memory/memory.max_usage_in_bytes" 2>/dev/null || echo n/a)
  cpu="$(cat "$cg/cpu/cpu.cfs_quota_us" 2>/dev/null) $(cat "$cg/cpu/cpu.cfs_period_us" 2>/dev/null)"
else
  echo "job-resources: no cgroup files found"; exit 0
fi
mb() { case "$1" in ''|*[!0-9]*) echo "$1" ;; *) echo "$(($1 / 1048576)) MB" ;; esac; }
pct=''
case "$limit$peak" in *[!0-9]*) ;; *) pct=" ($((peak * 100 / limit))% of limit)" ;; esac
echo "job-resources: cpu.max=[$cpu] nproc=$(nproc 2>/dev/null || echo n/a) memory.max=$(mb "$limit") memory.peak=$(mb "$peak")$pct"
