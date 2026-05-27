#!/bin/bash
# @desc: Simple hello-world Demo-Task
# @server: n8n VPS
set -euo pipefail

echo "Hello from $(hostname)!"
echo "Working dir: $(pwd)"
echo "Artifact dir: ${JOB_ARTIFACT_DIR:-not set}"
date > timestamp.txt
echo "Done. Saved timestamp.txt as artifact."
