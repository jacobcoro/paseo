---
name: study-analysis
description: Analyze uploaded data, perform calculations and create charts with actual Python results through the study computation tool.
---

Use `run_python` when the answer depends on numerical computation, data cleaning or a chart. Read the actual uploaded data rather than guessing its values. Pass only the relevant file IDs; inputs are `/work/inputs/<id>-<name>`.

Libraries include pandas, matplotlib, statistics and openpyxl. State assumptions, units and missing data. Report the computed result and relevant uncertainty. Save charts or tables in `/work/outputs`; use their returned download URLs. Use readable labels and suitable fonts, including Noto Sans CJK SC for Chinese.

Each computation has no network and a forty-second limit. Do not install packages or claim success after a tool error. Split long analyses into smaller operations.
