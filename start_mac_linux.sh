#!/bin/sh
# LinkedIn Lead Finder - start on macOS or Linux.  Run:  sh start_mac_linux.sh
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  exec python3 server.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python server.py "$@"
else
  echo "Python 3 is not installed. Get it from https://www.python.org/downloads/ and run this again."
  exit 1
fi
