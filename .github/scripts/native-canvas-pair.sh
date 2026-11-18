#!/usr/bin/env bash
set -euo pipefail
adb install perf/measure.apk
native_session=$(printf '%s' "$TEST_NATIVE_SESSION" | base64 -w0)
adb shell getprop ro.build.fingerprint > perf/device.txt
sample=0
for version in baseline candidate candidate baseline baseline candidate; do
  sample=$((sample+1))
  directory=acceptance
  if [ "$version" = baseline ]; then directory=acceptance-control; fi
  if adb shell pm path com.shotloom.app.preview | grep -q '^package:'; then
    adb uninstall com.shotloom.app.preview
  fi
  adb install "$directory/Shotloom-Preview.apk"
  adb install -r "$directory/Shotloom-Session-Test.apk"
  adb shell am instrument -w -e cookie "$TEST_SESSION_COOKIE" -e sessionBase64 "$native_session" com.shotloom.acceptance/com.shotloom.acceptance.SessionInstrumentation > /tmp/session-seeded.txt
  grep -q 'Test session installed' /tmp/session-seeded.txt
  adb shell am instrument -w -e mode canvas com.shotloom.performance/com.shotloom.performance.NativePerformance > /tmp/performance-output.txt
  python3 - "$sample" "$version" <<'PY'
import json,sys
text=open('/tmp/performance-output.txt').read()
line=next(s.split('PERFORMANCE_JSON ',1)[1] for s in text.splitlines() if 'PERFORMANCE_JSON ' in s)
result=json.loads(line)
result['version']=sys.argv[2]
with open('perf/results-canvas-'+sys.argv[1]+'.json','w') as f: json.dump(result,f,indent=2)
assert result['failure'] is None and len(result['pages'])==5 and not result['apis'], result
print('Canvas pair',sys.argv[1],sys.argv[2],[(r['page'],r['ms']) for r in result['pages']])
PY
done
