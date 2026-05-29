#!/bin/bash
# @desc: Probe — zeigt einzelne env-Vars (nur für env-pass-through-Test)
# @server: n8n VPS
set -eo pipefail
echo "FOO=${FOO:-<empty>}"
echo "MY_SECRET=${MY_SECRET:-<empty>}"
echo "PATH-length=${#PATH}"
echo "total env-vars: $(env | wc -l)"
