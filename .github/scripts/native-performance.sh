#!/usr/bin/env bash
set -euo pipefail
adb shell wm size 750x1624
adb shell wm density 320
adb shell settings put global private_dns_mode off
adb shell settings put system font_scale 1.0
adb install acceptance/Shotloom-Preview.apk
adb install acceptance/Shotloom-Session-Test.apk
adb install perf/measure.apk
native_session=$(printf '%s' "$TEST_NATIVE_SESSION" | base64 -w0)
adb shell am instrument -w -e cookie "$TEST_SESSION_COOKIE" -e sessionBase64 "$native_session" com.shotloom.acceptance/com.shotloom.acceptance.SessionInstrumentation > /tmp/session-seeded.txt
grep -q 'Test session installed' /tmp/session-seeded.txt
token=$(printf '%s' "$TEST_NATIVE_SESSION" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
project=$(printf '%s' "$TEST_FIXTURE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["projectId"])')
feedback=$(printf '%s' "$TEST_FIXTURE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["feedbackId"])')
adb shell getprop ro.build.fingerprint > perf/device.txt
for run in 1 2 3; do
  adb shell am instrument -w -e token "$token" -e projectId "$project" -e feedbackId "$feedback" com.shotloom.performance/com.shotloom.performance.NativePerformance > /tmp/performance-output.txt
  python3 - "$run" <<'PY'
import json,sys
text=open('/tmp/performance-output.txt').read()
line=next((s.split('PERFORMANCE_JSON ',1)[1] for s in text.splitlines() if 'PERFORMANCE_JSON ' in s),None)
if line is None: raise SystemExit('Measurement output missing')
result=json.loads(line)
with open('perf/results-'+sys.argv[1]+'.json','w') as f: json.dump(result,f,indent=2)
print('Run',sys.argv[1],':',len(result['pages']),'page samples;',len(result['apis']),'API samples; failure:',result['failure'])
if result['failure']: raise SystemExit(1)
PY
done
