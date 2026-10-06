import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  lstatSync,
  copyFileSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { documentRecords, documentFile, registerDocument, toolDirectories } from "./documents.mjs";

const run = promisify(execFile);
async function cleanupOwnedCompute(config) {
  const runtime = createHash("sha256").update(config.recordsDir).digest("hex");
  const found = await run(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      `label=lulu.study.runtime=${runtime}`,
      "--filter",
      "label=lulu.study.compute=owned",
    ],
    { timeout: 10000 },
  );
  const ids = found.stdout.split("\n").filter((id) => /^[a-f0-9]{12,64}$/.test(id));
  if (ids.length) await run("docker", ["rm", "-f", ...ids], { timeout: 10000 });
}
export const COMPUTE_LIMITS = { workers: 4, queue: 64, memoryMiB: 768, timeoutMs: 45000, pids: 64 };
export async function runPythonJob(config, student, request) {
  if (typeof request.code !== "string" || Buffer.byteLength(request.code) > 32000)
    throw Error("Python code must be under 32 KiB");
  if (
    !Array.isArray(request.files) ||
    request.files.length > 10 ||
    request.files.some((id) => !/^[a-f0-9]{64}$/.test(id))
  )
    throw Error("Select up to ten uploaded files");
  const owned = documentRecords(config, student);
  const inputs = request.files.map((id) => {
    const record = owned.find((file) => file.id === id);
    const file = documentFile(config, student, id);
    if (!record || !file) throw Error("File not found in this student's workspace");
    return { record, file };
  });
  const jobId = randomUUID();
  const name = "lulu-compute-" + jobId;
  const root = join(config.recordsDir, "computation", student.id, jobId);
  mkdirSync(join(root, "inputs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "outputs"), { mode: 0o700 });
  for (const { record, file } of inputs)
    copyFileSync(file.path, join(root, "inputs", record.id + "-" + basename(record.name)));
  writeFileSync(join(root, "job.py"), request.code, { mode: 0o600 });
  // This process is discarded independently of model behavior, including when
  // the broker dies: the timeout runs inside the credential-free container.
  const watchdog =
    "import os,signal,subprocess,tempfile,json,base64\nwith tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:\n p=subprocess.Popen(['python','-I','/work/job.py'],stdout=out,stderr=err,start_new_session=True)\n try: p.wait(timeout=40)\n except subprocess.TimeoutExpired:\n  os.killpg(p.pid,signal.SIGKILL); p.wait()\n out.seek(0); err.seek(0)\n result={'success':p.returncode==0,'stdout':out.read(16000).decode('utf-8','replace'),'stderr':err.read(4000).decode('utf-8','replace'),'files':[]}\n total=0\n for name in os.listdir('/work/outputs')[:10]:\n  path='/work/outputs/'+name\n  if os.path.islink(path) or not os.path.isfile(path): continue\n  size=os.stat(path).st_size\n  if size>8388608 or total+size>31457280: continue\n  total+=size\n  with open(path,'rb') as f: result['files'].append({'name':name,'data':base64.b64encode(f.read()).decode('ascii')})\n print(json.dumps(result))\n";
  writeFileSync(join(root, "watchdog.py"), watchdog, { mode: 0o600 });
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--label",
    "lulu.study.compute=owned",
    "--label",
    `lulu.study.runtime=${createHash("sha256").update(config.recordsDir).digest("hex")}`,
    "--label",
    `lulu.study.student=${student.id}`,
    "--memory",
    "768m",
    "--memory-swap",
    "768m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
    "--tmpfs",
    "/work/outputs:rw,noexec,nosuid,size=32m,uid=1000,gid=1000",
    "--mount",
    `type=bind,src=${root},dst=/work,readonly`,
    config.computeImage || "lulu-study-compute:demo",
    "python",
    "-I",
    "/work/watchdog.py",
  ];
  let output = "",
    error = "",
    failed = false;
  try {
    const result = await run("docker", args, {
      timeout: COMPUTE_LIMITS.timeoutMs,
      maxBuffer: 48 * 1024 * 1024,
    });
    output = result.stdout;
    error = result.stderr;
  } catch (failure) {
    failed = true;
    output = String(failure.stdout || "");
    error = String(failure.stderr || failure.message);
  } finally {
    await run("docker", ["rm", "-f", name], { timeout: 5000 }).catch(() => {});
  }
  const generated = [];
  let computation = {
    success: false,
    stdout: output.slice(0, 16000),
    stderr: error.slice(0, 4000),
    files: [],
  };
  if (!failed) {
    try {
      computation = JSON.parse(output);
    } catch {
      computation.stderr = "Invalid computation result";
    }
  }
  for (const file of (computation.files || []).slice(0, 10)) {
    try {
      const exporter = config.registerComputationOutput || registerDocument;
      generated.push(
        exporter(config, student, file.name, Buffer.from(file.data, "base64"), "output", {
          jobId,
        }),
      );
    } catch (failure) {
      error += "\n" + failure.message;
    }
  }
  const result = {
    jobId,
    success: !failed && computation.success === true,
    stdout: String(computation.stdout || "").slice(0, 16000),
    stderr: (String(computation.stderr || "") + error).slice(0, 4000),
    files: generated,
  };
  writeFileSync(join(root, "result.json"), JSON.stringify(result), { mode: 0o600 });
  appendFileSync(
    join(config.recordsDir, `${student.id}.tools.jsonl`),
    JSON.stringify({ at: new Date().toISOString(), operation: "run_python", request, result }) +
      "\n",
    { mode: 0o600 },
  );
  // Accepted code and result are recorded, but ephemeral inputs are unnecessary duplicates.
  rmSync(join(root, "inputs"), { recursive: true, force: true });
  return result;
}
export async function handleTool(config, student, request) {
  if (student.profile === "employee-production") {
    const { handleEmployeeTool } = await import("./employee-tools.mjs");
    return handleEmployeeTool(config, student, request);
  }
  if (request.operation === "list_files") return documentRecords(config, student);
  if (request.operation === "run_python") return runPythonJob(config, student, request);
  if (request.operation === "write_text")
    return registerDocument(
      config,
      student,
      request.name,
      Buffer.from(request.text || ""),
      "output",
    );
  if (request.operation === "read_file") {
    const file = documentFile(config, student, request.id);
    if (!file) throw Error("File not found");
    if (!/^(text\/|application\/json)/.test(file.mimeType))
      throw Error("Use run_python to read PDFs or Office files");
    const text = readFileSync(file.path, "utf8");
    return { text: text.slice(0, 60000), truncated: text.length > 60000 };
  }
  throw Error("Unknown study tool");
}
export function startToolWorker(config) {
  const employeeRuntime = config.students.every(
    (student) => student.profile === "employee-production",
  );
  const workers = employeeRuntime ? 1 : COMPUTE_LIMITS.workers;
  const pending = [],
    active = new Set(),
    seen = new Set();
  let stopped = false;
  for (const student of config.students) toolDirectories(config, student);
  async function process(entry) {
    try {
      const path = join(entry.directories.inbox, entry.file);
      let result;
      try {
        if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 256 * 1024)
          throw Error("Invalid tool request");
        const request = JSON.parse(readFileSync(path, "utf8"));
        result = { result: await handleTool(config, entry.student, request) };
      } catch (error) {
        result = { error: error.message };
      }
      const destination = join(entry.directories.results, entry.file);
      writeFileSync(destination + ".tmp", JSON.stringify(result), { mode: 0o600 });
      renameSync(destination + ".tmp", destination);
      rmSync(path, { force: true });
    } finally {
      active.delete(entry.key);
      drain();
    }
  }
  function drain() {
    if (stopped) return;
    while (active.size < workers && pending.length) {
      const entry = pending.shift();
      active.add(entry.key);
      void process(entry).catch((error) =>
        console.error("Study tool request failed:", error.message),
      );
    }
  }
  function scan() {
    if (stopped) return;
    for (const student of config.students) {
      const directories = toolDirectories(config, student);
      for (const file of readdirSync(directories.inbox)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
        const key = student.id + "/" + file;
        if (seen.has(key)) continue;
        if (pending.length >= COMPUTE_LIMITS.queue) {
          writeFileSync(
            join(directories.results, file),
            JSON.stringify({ error: "Computation is busy. Retry shortly." }),
            { mode: 0o600 },
          );
          rmSync(join(directories.inbox, file), { force: true });
          continue;
        }
        seen.add(key);
        pending.push({ student, directories, file, key });
      }
    }
    drain();
  }
  // Restart cannot overlap a previous pool. Only this runtime's labelled
  // credential-free workers are removed before admitting another computation.
  const ready = cleanupOwnedCompute(config);
  let initialized = false;
  void ready
    .then(() => {
      initialized = true;
      scan();
      return null;
    })
    .catch((error) => {
      stopped = true;
      console.error("Study computation startup failed:", error.message);
    });
  const timer = setInterval(() => {
    if (initialized) scan();
  }, 250);
  return async () => {
    stopped = true;
    clearInterval(timer);
    while (active.size) await new Promise((resolve) => setTimeout(resolve, 100));
  };
}
if (process.argv[1]?.endsWith("tool-worker.mjs")) {
  const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const stop = startToolWorker(config);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      void stop().then(() => process.exit());
    });
}
