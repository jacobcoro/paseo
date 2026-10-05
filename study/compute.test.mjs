import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerDocument, documentFile } from "./documents.mjs";
import { runPythonJob } from "./tool-worker.mjs";

test("credential-free bounded Python computes real data and returns documents and charts", async () => {
  const root = mkdtempSync(join(homedir(), ".cache", "lulu-compute-"));
  const config = { recordsDir: join(root, "records") };
  mkdirSync(config.recordsDir);
  const student = { id: "s01", workspacePath: join(root, "workspace") };
  try {
    const input = registerDocument(config, student, "data.csv", Buffer.from("value\n2\n4\n6\n"));
    const result = await runPythonJob(config, student, {
      files: [input.id],
      code: `import os,json,pandas as pd,matplotlib.pyplot as plt
from docx import Document
from pptx import Presentation
from reportlab.pdfgen.canvas import Canvas
data=pd.read_csv('/work/inputs/${input.id}-data.csv')
assert not os.path.exists('/home/node/.codex/auth.json')
assert open('/sys/fs/cgroup/memory.max').read().strip()=='805306368'
assert open('/sys/fs/cgroup/memory.swap.max').read().strip()=='0'
assert open('/sys/fs/cgroup/pids.max').read().strip()=='64'
print(json.dumps({'mean':float(data['value'].mean())}))
data.to_excel('/work/outputs/table.xlsx',index=False)
document=Document();document.add_paragraph('Mean: 4');document.save('/work/outputs/report.docx')
deck=Presentation();deck.slides.add_slide(deck.slide_layouts[0]);deck.save('/work/outputs/slides.pptx')
pdf=Canvas('/work/outputs/report.pdf');pdf.drawString(50,700,'Mean: 4');pdf.save()
plt.plot(data['value']);plt.savefig('/work/outputs/chart.png')
os.symlink('/etc/passwd','/work/outputs/forbidden.txt')
`,
    });
    assert.equal(result.success, true, result.stderr);
    assert.equal(JSON.parse(result.stdout).mean, 4);
    assert.deepEqual(result.files.map((file) => file.name).sort(), [
      "chart.png",
      "report.docx",
      "report.pdf",
      "slides.pptx",
      "table.xlsx",
    ]);
    assert.equal(
      result.files.every((file) => documentFile(config, student, file.id) !== null),
      true,
    );
    await assert.rejects(
      runPythonJob(config, { ...student, id: "s02" }, { files: [input.id], code: "print('no')" }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
