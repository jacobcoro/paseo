ARG COMPUTE_BASE=lulu-study-compute:demo
FROM ${COMPUTE_BASE}
USER root
RUN python -c "from pathlib import Path; assert Path('/sys/fs/cgroup/memory.max').read_text().strip()=='1073741824'; assert Path('/sys/fs/cgroup/memory.swap.max').read_text().strip()=='0'; assert Path('/sys/fs/cgroup/cpu.max').read_text().split()==['100000','100000']" \
    && timeout 180 sh -c 'apt-get update && apt-get install -y --no-install-recommends ffmpeg' \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
