import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { employeeToolArguments } from "./employee-profile.mjs";
import { documentRecords, documentFile, registerDocument } from "./documents.mjs";
import { runPythonJob } from "./tool-worker.mjs";
import {
  assertEmployeeControl,
  revokeEmployeeLifecycle,
  employeeOwner,
  withEmployeeSubmitLease,
} from "./employee-lifecycle.mjs";
const run = promisify(execFile);

const Binding = z
  .object({
    job_id: z.string().min(1).max(200),
    producer_id: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
  })
  .strict();
export function assertEmployeeAssignment(worker, request) {
  return assertEmployeeControl(worker, Binding.parse(request.assignment));
}

export async function revokeEmployeeTools(config, worker, binding) {
  if (
    worker.employeeScope?.runtime_id !==
    createHash("sha256").update(config.recordsDir).digest("hex")
  )
    throw Error("Employee runtime owner mismatch");
  return revokeEmployeeLifecycle(worker, Binding.parse(binding));
}

// The future Hermes caller must hold this through SDK acceptance, never merely
// call an active check before send. Its integration remains a separate hold.
export async function withEmployeeSubmit(config, worker, binding, send) {
  if (
    worker.employeeScope?.runtime_id !==
    createHash("sha256").update(config.recordsDir).digest("hex")
  )
    throw Error("Employee runtime owner mismatch");
  return withEmployeeSubmitLease(worker, Binding.parse(binding), send);
}

export function handleEmployeeTool(config, worker, request) {
  return employeeOwner(worker).operation(Binding.parse(request.assignment), (lease) =>
    handleAssignedTool(config, worker, request, lease),
  );
}
async function handleAssignedTool(config, worker, request, lease) {
  assertEmployeeAssignment(worker, request);
  const { operation, assignment: _assignment, files, ...values } = request;
  if (operation !== "render_video" && (!Array.isArray(files) || files.length)) {
    throw Error("Unexpected employee file inputs");
  }
  const args = employeeToolArguments(
    operation,
    operation === "render_video" ? { ...values, files } : values,
  );
  let result;
  if (operation === "list_files") result = documentRecords(config, worker);
  else if (operation === "read_file") {
    const file = documentFile(config, worker, args.id);
    if (!file) throw Error("File not found in this concept");
    if (!/^(text\/|application\/json)/.test(file.mimeType))
      throw Error("Use registered media with render_video");
    const text = readFileSync(file.path, "utf8");
    result = { text: text.slice(0, 60000), truncated: text.length > 60000 };
  } else if (operation === "write_text") {
    const prefix = createHash("sha256").update(request.assignment.revision).digest("hex");
    result = registerDocument(
      config,
      worker,
      prefix + "-" + args.name,
      Buffer.from(args.text),
      "output",
      {
        job_id: request.assignment.job_id,
        producer_id: request.assignment.producer_id,
        revision: request.assignment.revision,
      },
    );
  } else result = await renderEmployeeVideo(config, worker, request, args, lease);
  assertEmployeeAssignment(worker, request);
  return result;
}

export async function renderEmployeeVideo(config, worker, request, args, lease) {
  if (!lease) throw Error("Employee render requires its sole host worker");
  assertEmployeeAssignment(worker, request);
  if (!/^sha256:[a-f0-9]{64}$/.test(worker.employeeMediaImage || "")) {
    throw Error("Employee media executor is unavailable");
  }
  const owned = documentRecords(config, worker);
  const sources = args.files.map((id) => {
    const file = owned.find((record) => record.id === id);
    if (
      !file ||
      file.mimeType !== "video/mp4" ||
      file.approvedSource !== true ||
      file.kind !== "upload"
    )
      throw Error("Rendering requires this concept's approved footage");
    return "/work/inputs/" + file.id + "-" + file.name;
  });
  const storagePolicy = config.employeeStoragePolicyScript;
  if (
    typeof storagePolicy !== "string" ||
    !isAbsolute(storagePolicy) ||
    lstatSync(storagePolicy).isSymbolicLink()
  ) {
    throw Error("Reviewed host storage policy is required for employee rendering");
  }
  await run("python3", [storagePolicy, "--path", config.recordsDir], { timeout: 5000 });
  assertEmployeeAssignment(worker, request);
  // No employee code or argument string reaches a host shell. This fixed
  // recipe runs inside the existing credential-free disposable executor.
  const specification = JSON.stringify({ sources, duration: args.duration_seconds });
  const code = `import json,subprocess,os
spec=json.loads(${JSON.stringify(specification)})
segments=[]
duration=spec['duration']/len(spec['sources'])
for index,source in enumerate(spec['sources']):
 path='/tmp/segment-'+str(index)+'.mp4'
 subprocess.run(['ffmpeg','-nostdin','-v','error','-threads','1','-i',source,'-t',str(duration),'-vf','scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1','-filter_threads','1','-an','-r','30','-c:v','libx264','-threads','1','-preset','veryfast','-crf','28','-pix_fmt','yuv420p','-y',path],check=True,timeout=25)
 segments.append(path)
with open('/tmp/segments.txt','w') as handle:
 for path in segments: handle.write("file '"+os.path.basename(path)+"'\\n")
subprocess.run(['ffmpeg','-nostdin','-v','error','-f','concat','-safe','1','-i','/tmp/segments.txt','-c','copy','-movflags','+faststart','-y','/work/outputs/draft.mp4'],check=True,timeout=5)
assert os.stat('/work/outputs/draft.mp4').st_size <= 8388608
print(json.dumps({'rendered':True,'audio':'none','width':720,'height':1280}))
`;
  const scopedConfig = {
    ...config,
    employeeOperation: lease,
    computeImage: worker.employeeMediaImage,
    registerComputationOutput: (outputConfig, owner, name, bytes, kind, details) => {
      assertEmployeeAssignment(worker, request);
      if (name !== "draft.mp4") throw Error("Unexpected employee render output");
      const revisionName =
        "draft-" + createHash("sha256").update(request.assignment.revision).digest("hex") + ".mp4";
      return registerDocument(outputConfig, owner, revisionName, bytes, kind, {
        ...details,
        productionMedia: true,
        job_id: request.assignment.job_id,
        producer_id: request.assignment.producer_id,
        revision: request.assignment.revision,
      });
    },
  };
  const result = await runPythonJob(scopedConfig, worker, { code, files: args.files });
  assertEmployeeAssignment(worker, request);
  if (!result.success || result.files.length !== 1 || result.files[0].mimeType !== "video/mp4") {
    throw Error("Employee render failed; inspect this job's private result");
  }
  return {
    job_id: request.assignment.job_id,
    producer_id: request.assignment.producer_id,
    revision: request.assignment.revision,
    computation_id: result.jobId,
    media: result.files[0],
    fixture_spend: 0,
    external_send: false,
  };
}
