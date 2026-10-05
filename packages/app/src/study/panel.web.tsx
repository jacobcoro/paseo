import { useCallback, useEffect, useMemo, useReducer, useState, type Dispatch } from "react";
import { useRouter, usePathname, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "@/hooks/use-settings";
import { studyLabel } from "./language";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { EditingTextInput } from "@/components/ui/text-input";

const Student = z.object({
  studentId: z.string(),
  mode: z.enum(["fixture", "live"]),
  agentId: z.string(),
  serverId: z.string(),
  model: z.string(),
});
const Records = z.object({
  prompts: z.array(z.object({ id: z.string(), text: z.string(), timestamp: z.string() })),
  annotations: z.array(z.object({ id: z.string() }).passthrough()),
});
const Conversation = z.object({
  agentId: z.string(),
  title: z.string(),
  createdAt: z.string().nullable(),
  readonly: z.boolean(),
});
const Conversations = z.object({
  conversations: z.array(Conversation),
});
const ModelSettings = z.object({
  agentId: z.string(),
  modelId: z.string(),
  thinkingOptionId: z.string().nullable(),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      defaultThinkingOptionId: z.string().nullable(),
      thinkingOptions: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
});
const Files = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      mimeType: z.string(),
      bytes: z.number(),
      kind: z.enum(["upload", "output"]),
      recordedAt: z.string(),
    }),
  ),
});
const DEFAULT_FORM = {
  promptId: "non-ai",
  phase: "Discover",
  task: "",
  purpose: "",
  nextAction: "",
  modified: "no",
  adoption: "none",
  finalUse: "",
};
type ResearchForm = typeof DEFAULT_FORM;
interface ResearchState {
  form: ResearchForm;
  saved: boolean;
}
type ResearchAction = { type: "change"; patch: Partial<ResearchForm> } | { type: "saved" };
function reduceForm(state: ResearchState, action: ResearchAction): ResearchState {
  if (action.type === "saved") return { ...state, saved: true };
  return { form: { ...state.form, ...action.patch }, saved: false };
}
async function getJson(path: string) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("无法读取记录 / Could not load records");
  return response.json();
}
const phases = ["Discover", "Define", "Develop", "Deliver"].map((value) => ({
  id: value,
  value,
  label: value,
}));
const adoption = [
  { id: "all", value: "all", label: "完全采用 / All" },
  { id: "most", value: "most", label: "大部分采用 / Most" },
  { id: "some", value: "some", label: "部分采用 / Some" },
  { id: "little", value: "little", label: "小部分采用 / Little" },
  { id: "none", value: "none", label: "不采用 / None" },
  { id: "not-applicable", value: "not-applicable", label: "未使用 AI / No AI" },
];
const modified = [
  { id: "no", value: "no", label: "否 / No" },
  { id: "yes", value: "yes", label: "是 / Yes" },
  { id: "not-applicable", value: "not-applicable", label: "未使用 AI / No AI" },
];

const SHEET_HEADER = { title: "研究记录 / Research record" };
interface StudySelectProps {
  name: keyof ResearchForm;
  label: string;
  value: string;
  options: { id: string; value: string; label: string }[];
  dispatch: Dispatch<ResearchAction>;
}
function StudySelect({ name, label, value, options, dispatch }: StudySelectProps) {
  const { i18n } = useTranslation();
  const translatedOptions = useMemo(
    () => options.map((option) => ({ ...option, label: studyLabel(option.label, i18n.language) })),
    [options, i18n.language],
  );
  const display = useMemo(
    () => translatedOptions.find((item) => item.value === value) || null,
    [translatedOptions, value],
  );
  const change = useCallback(
    (next: string) => dispatch({ type: "change", patch: { [name]: next } }),
    [name, dispatch],
  );
  return (
    <SelectField
      label={studyLabel(label)}
      value={value}
      selectedDisplay={display}
      options={translatedOptions}
      placeholder={studyLabel("选择 / Select")}
      emptyText={studyLabel("暂无记录 / No records")}
      onChange={change}
      searchable
      size="sm"
    />
  );
}
function StudyTextField({ name, label, value, dispatch }: Omit<StudySelectProps, "options">) {
  const change = useCallback(
    (text: string) => dispatch({ type: "change", patch: { [name]: text } }),
    [name, dispatch],
  );
  return (
    <Field label={studyLabel(label)}>
      <FormTextInput
        accessibilityLabel={studyLabel(label)}
        initialValue={value}
        onChangeText={change}
        multiline
        size="sm"
      />
    </Field>
  );
}
function ResearchSheet({ close }: { close: () => void }) {
  const { i18n } = useTranslation();
  const header = useMemo(
    () => ({ title: studyLabel(SHEET_HEADER.title, i18n.language) }),
    [i18n.language],
  );
  const [state, dispatch] = useReducer(reduceForm, { form: DEFAULT_FORM, saved: false });
  const queryClient = useQueryClient();
  const records = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 2000,
    queryKey: ["study-records"],
    queryFn: async () => Records.parse(await getJson("/study/records")),
    refetchInterval: 5000,
  });
  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch("/study/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.form),
      });
      if (!response.ok)
        throw new Error("请填写当前任务与下一步行动 / Complete task and next action");
      return response.json();
    },
    onSuccess: () => {
      dispatch({ type: "saved" });
      void queryClient.invalidateQueries({ queryKey: ["study-records"] });
    },
  });
  const prompts = useMemo(
    () => [
      { id: "non-ai", value: "non-ai", label: "未使用 AI 的设计步骤 / Non-AI step" },
      ...(records.data?.prompts || []).map((prompt, index) => ({
        id: prompt.id,
        value: prompt.id,
        label: `${index + 1}. ${prompt.text.slice(0, 70)}`,
      })),
    ],
    [records.data],
  );
  const fields = [
    { key: "task", label: "当前任务 / Current task" },
    { key: "purpose", label: "使用 AI 目的 / Purpose of AI use" },
    { key: "nextAction", label: "我接下来做了什么 / What I did next" },
    { key: "finalUse", label: "最终用途与备注 / Final use and notes" },
  ] as const;
  const submit = useCallback(() => save.mutate(), [save]);
  return (
    <AdaptiveModalSheet visible header={header} onClose={close} desktopMaxWidth={600}>
      <View style={styles.form}>
        <StudySelect
          name="promptId"
          label={studyLabel("记录对应的提示词 / Prompt")}
          value={state.form.promptId}
          options={prompts}
          dispatch={dispatch}
        />
        <StudySelect
          name="phase"
          label={studyLabel("设计阶段 / Phase")}
          value={state.form.phase}
          options={phases}
          dispatch={dispatch}
        />
        {fields.map(({ key, label }) => (
          <StudyTextField
            key={key}
            name={key}
            label={studyLabel(label)}
            value={state.form[key]}
            dispatch={dispatch}
          />
        ))}
        <StudySelect
          name="modified"
          label={studyLabel("是否修改 AI 结果 / Modified?")}
          value={state.form.modified}
          options={modified}
          dispatch={dispatch}
        />
        <StudySelect
          name="adoption"
          label={studyLabel("最终是否采用 / Adoption")}
          value={state.form.adoption}
          options={adoption}
          dispatch={dispatch}
        />
        {records.isError && (
          <Text style={styles.error}>{studyLabel(records.error.message || "")}</Text>
        )}
        {save.isError && <Text style={styles.error}>{studyLabel(save.error.message || "")}</Text>}
        {state.saved && <Text style={styles.text}>{studyLabel("已保存 / Saved")}</Text>}
        <Text style={styles.muted}>
          {records.data?.annotations.length || 0} {studyLabel("条记录已保存 / records saved")}
        </Text>
        <Button onPress={submit} loading={save.isPending}>
          {studyLabel("保存记录 / Save record")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

type StudyStudent = z.infer<typeof Student>;

function LanguageToggle() {
  const { i18n } = useTranslation();
  const { updateSettings } = useAppSettings();
  const change = useMutation({
    mutationFn: async () => {
      const language = i18n.language === "en" ? "zh-CN" : "en";
      localStorage.setItem("study.language", language);
      await updateSettings({ language });
    },
  });
  const toggle = useCallback(() => change.mutate(), [change]);
  return (
    <>
      <Button size="sm" variant="ghost" onPress={toggle} loading={change.isPending}>
        {i18n.language === "en" ? "中文" : "English"}
      </Button>
      {change.isError && (
        <Text style={styles.error}>{studyLabel("Could not change language")}</Text>
      )}
    </>
  );
}

export function StudyPanel() {
  useTranslation();
  const [open, setOpen] = useState(false);
  const student = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 2000,
    queryKey: ["study-student"],
    queryFn: async () => Student.parse(await getJson("/study/me")),
  });
  const router = useRouter();
  const pathname = usePathname();
  const logout = useMutation({
    mutationFn: async () => {
      const response = await fetch("/study/logout", { method: "POST" });
      if (!response.ok) throw new Error("Sign out failed");
      window.location.replace("/");
    },
  });
  const openSheet = useCallback(() => setOpen(true), []);
  const closeSheet = useCallback(() => setOpen(false), []);
  const exportRecords = useCallback(() => {
    window.location.href = "/study/export";
  }, []);
  const signOut = useCallback(() => logout.mutate(), [logout]);
  const connected = useHostRuntimeIsConnected(student.data?.serverId || "");
  useEffect(() => {
    if (
      !student.data ||
      !connected ||
      !["/", "/welcome", "/open-project", "/new", "/history", "/settings"].includes(pathname)
    )
      return;
    router.replace({
      pathname: "/h/[serverId]/agent/[agentId]",
      params: { serverId: student.data.serverId, agentId: student.data.agentId },
    });
  }, [student.data, connected, pathname, router]);
  if (!student.data) return null;
  const modeLabel =
    student.data.mode === "fixture" ? "演示 · 固定回答 / Fixture demo" : "Codex · Live";
  return (
    <>
      <View style={styles.banner}>
        <View style={styles.identity}>
          <Text style={styles.text}>Lulu · {student.data.studentId}</Text>
          <Text style={styles.muted}>{studyLabel(modeLabel)}</Text>
          <Text style={styles.muted}>
            {studyLabel("图片 / Images: PNG, JPEG, WebP · 4 / prompt · 2 MiB / image")}
          </Text>
        </View>
        <LanguageToggle />
        <Button size="sm" onPress={openSheet}>
          {studyLabel("研究记录 / Record")}
        </Button>
        <Button size="sm" variant="ghost" onPress={exportRecords}>
          {studyLabel("导出 / Export")}
        </Button>
        <Button size="sm" variant="ghost" loading={logout.isPending} onPress={signOut}>
          {studyLabel("退出 / Sign out")}
        </Button>
      </View>
      {logout.isError && <Text style={styles.error}>{studyLabel(logout.error.message || "")}</Text>}
      <StudyTools student={student.data} />
      {open && <ResearchSheet close={closeSheet} />}
    </>
  );
}

interface StudyToolsProps {
  student: StudyStudent;
}

function StudyTools({ student }: StudyToolsProps) {
  const { i18n } = useTranslation();
  const [selectedAgentId, setSelectedAgentId] = useState(student.agentId);
  const [voiceNotice, setVoiceNotice] = useState("");
  const router = useRouter();
  const routeParams = useLocalSearchParams<{ agentId?: string | string[] }>();
  const routeAgentId = Array.isArray(routeParams.agentId)
    ? routeParams.agentId[0]
    : routeParams.agentId;
  useEffect(() => {
    if (routeAgentId) setSelectedAgentId(routeAgentId);
  }, [routeAgentId]);
  const focusedAgentId = useSessionStore(
    (state) => state.sessions[student.serverId]?.focusedAgentId,
  );
  useEffect(() => {
    if (focusedAgentId) setSelectedAgentId(focusedAgentId);
  }, [focusedAgentId]);
  const queryClient = useQueryClient();
  const conversations = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 2000,
    queryKey: ["study-conversations"],
    queryFn: async () => Conversations.parse(await getJson("/study/conversations")),
    refetchInterval: 10000,
  });
  const options = useMemo(
    () =>
      (conversations.data?.conversations || []).map((conversation) => ({
        id: conversation.agentId,
        value: conversation.agentId,
        label: conversation.title,
        description: conversation.readonly ? studyLabel("Read only", i18n.language) : undefined,
      })),
    [conversations.data, i18n.language],
  );
  const selected = useMemo(
    () => options.find((item) => item.value === selectedAgentId) || options[0] || null,
    [options, selectedAgentId],
  );
  const create = useMutation({
    mutationFn: async () => {
      const response = await fetch("/study/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New chat" }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not create chat");
      return Conversation.parse(result);
    },
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: ["study-conversations"] });
      setSelectedAgentId(conversation.agentId);
      router.replace({
        pathname: "/h/[serverId]/agent/[agentId]",
        params: { serverId: student.serverId, agentId: conversation.agentId },
      });
    },
  });
  const switchConversation = useCallback(
    (agentId: string) => {
      setSelectedAgentId(agentId);
      router.replace({
        pathname: "/h/[serverId]/agent/[agentId]",
        params: { serverId: student.serverId, agentId },
      });
    },
    [router, student.serverId],
  );
  const selectedDisplay = useMemo(() => (selected ? { label: selected.label } : null), [selected]);
  const createNewChat = useCallback(() => create.mutate(), [create]);
  const dictateCurrent = useCallback(() => dictate(setVoiceNotice), []);
  const readCurrent = useCallback(
    () => void readLatestReply(selected?.value || "", setVoiceNotice),
    [selected],
  );
  return (
    <>
      <View style={styles.tools}>
        <SelectField
          label={studyLabel("Chat / 对话")}
          value={selected?.value || null}
          selectedDisplay={selectedDisplay}
          options={options}
          onChange={switchConversation}
          placeholder={studyLabel("Choose chat")}
          emptyText={studyLabel("No chats")}
          searchable
          size="sm"
          disabled={!options.length}
        />
        <Button size="sm" onPress={createNewChat} loading={create.isPending}>
          {studyLabel("New chat")}
        </Button>
        {student.mode === "live" &&
          conversations.data?.conversations.some(
            (item) => item.agentId === selectedAgentId && !item.readonly,
          ) && <ModelControls key={selectedAgentId} agentId={selectedAgentId} />}
        {create.isError && (
          <Text style={styles.error}>{studyLabel(create.error.message || "")}</Text>
        )}
        <DocumentControls setNotice={setVoiceNotice} />
        <Button size="sm" variant="ghost" onPress={dictateCurrent}>
          {studyLabel("Dictate")}
        </Button>
        <Button size="sm" variant="ghost" onPress={readCurrent}>
          {studyLabel("Read latest reply")}
        </Button>
        <MemoryControls />
      </View>
      {!!voiceNotice && <Text style={styles.muted}>{studyLabel(voiceNotice)}</Text>}
    </>
  );
}

function ModelControls({ agentId }: { agentId: string }) {
  const { i18n } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["study-model-settings", agentId], [agentId]);
  const settings = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 2000,
    queryKey,
    queryFn: async () =>
      ModelSettings.parse(await getJson(`/study/settings?agentId=${encodeURIComponent(agentId)}`)),
    refetchInterval: 10000,
  });
  const change = useMutation({
    mutationFn: async (input: { modelId: string; thinkingOptionId: string }) => {
      const response = await fetch("/study/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, ...input }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not change model settings");
      return ModelSettings.parse(result);
    },
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });
  const model = settings.data?.models.find((item) => item.id === settings.data?.modelId);
  const models = useMemo(
    () =>
      (settings.data?.models || []).map((item) => ({
        id: item.id,
        value: item.id,
        label: item.label,
      })),
    [settings.data],
  );
  const levels = useMemo(
    () =>
      (model?.thinkingOptions || []).map((item) => ({
        id: item.id,
        value: item.id,
        label: studyLabel(item.label, i18n.language),
      })),
    [model, i18n.language],
  );
  const chooseModel = useCallback(
    (modelId: string) => {
      const next = settings.data?.models.find((item) => item.id === modelId);
      if (!next) return;
      const current = settings.data?.thinkingOptionId;
      const thinkingOptionId = next.thinkingOptions.some((item) => item.id === current)
        ? current
        : next.defaultThinkingOptionId;
      if (thinkingOptionId) change.mutate({ modelId, thinkingOptionId });
    },
    [settings.data, change],
  );
  const chooseReasoning = useCallback(
    (thinkingOptionId: string) => {
      if (model) change.mutate({ modelId: model.id, thinkingOptionId });
    },
    [model, change],
  );
  const modelDisplay = useMemo(() => (model ? { label: model.label } : null), [model]);
  const reasoningDisplay = useMemo(() => {
    const level = levels.find((item) => item.id === settings.data?.thinkingOptionId);
    return level ? { label: level.label } : null;
  }, [levels, settings.data]);
  return (
    <>
      <SelectField
        label={studyLabel("模型 / Model")}
        size="sm"
        value={settings.data?.modelId || null}
        selectedDisplay={modelDisplay}
        options={models}
        onChange={chooseModel}
        disabled={change.isPending || !models.length}
        placeholder={studyLabel("Loading models")}
        emptyText={studyLabel("No models available")}
        searchable
      />
      <SelectField
        label={studyLabel("推理 / Reasoning")}
        size="sm"
        value={settings.data?.thinkingOptionId || null}
        selectedDisplay={reasoningDisplay}
        options={levels}
        onChange={chooseReasoning}
        disabled={change.isPending || !levels.length}
        placeholder={studyLabel("Reasoning")}
        emptyText={studyLabel("No reasoning options available")}
      />
      {change.isPending && <Text style={styles.muted}>{studyLabel("Saving settings…")}</Text>}
      {(settings.isError || change.isError) && (
        <Text style={styles.error}>
          {studyLabel(change.error?.message || settings.error?.message || "")}
        </Text>
      )}
    </>
  );
}

function DocumentControls({ setNotice }: { setNotice: (message: string) => void }) {
  const queryClient = useQueryClient();
  const files = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 2000,
    queryKey: ["study-files"],
    queryFn: async () => Files.parse(await getJson("/study/files")),
    refetchInterval: 10000,
  });
  const upload = useMutation({
    mutationFn: async (input: { name: string; data: string }) => {
      const response = await fetch("/study/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed");
      return result;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["study-files"] }),
  });
  const pick = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json";
    input.addEventListener(
      "change",
      () => {
        void (async () => {
          for (const file of Array.from(input.files || [])) {
            if (file.size > 8 * 1024 * 1024) {
              setNotice(`${file.name}: ${studyLabel("File is over 8 MiB")}`);
              continue;
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 0x8000)
              binary += String.fromCharCode(
                ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
              );
            await upload.mutateAsync({ name: file.name, data: btoa(binary) });
          }
          setNotice("Upload complete. Ask about the file by name.");
        })().catch((error: unknown) =>
          setNotice(error instanceof Error ? error.message : "Upload failed"),
        );
      },
      { once: true },
    );
    input.click();
  }, [setNotice, upload]);
  const download = useCallback((id: string) => {
    window.location.href = `/study/file/${encodeURIComponent(id)}`;
  }, []);
  const uploadError = upload.error?.message || "Upload failed";
  return (
    <>
      <Button size="sm" variant="ghost" onPress={pick} loading={upload.isPending}>
        {studyLabel("Upload documents")}
      </Button>
      {files.data?.files.map((file) => (
        <DocumentDownloadButton key={file.id} file={file} onDownload={download} />
      ))}
      {upload.isError && <Text style={styles.error}>{studyLabel(uploadError || "")}</Text>}
      {files.isError && <Text style={styles.error}>{studyLabel(files.error.message || "")}</Text>}
    </>
  );
}

function DocumentDownloadButton({
  file,
  onDownload,
}: {
  file: z.infer<typeof Files>["files"][number];
  onDownload: (id: string) => void;
}) {
  const download = useCallback(() => onDownload(file.id), [file.id, onDownload]);
  return (
    <Button size="sm" variant="ghost" onPress={download}>
      {file.name} · {studyLabel("Download")}
    </Button>
  );
}

function MemoryControls() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const queryClient = useQueryClient();
  const memory = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 2000,
    queryKey: ["study-memory"],
    queryFn: async () =>
      z
        .object({ text: z.string(), updatedAt: z.string().nullable() })
        .parse(await getJson("/study/memory")),
  });
  useEffect(() => {
    if (memory.data) setText(memory.data.text);
  }, [memory.data]);
  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch("/study/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save memory");
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["study-memory"] }),
  });
  const clear = useMutation({
    mutationFn: async () => {
      const response = await fetch("/study/memory", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not clear memory");
    },
    onSuccess: () => {
      setText("");
      void queryClient.invalidateQueries({ queryKey: ["study-memory"] });
    },
  });
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const saveMemory = useCallback(() => save.mutate(), [save]);
  const clearMemory = useCallback(() => clear.mutate(), [clear]);
  return (
    <>
      <Button size="sm" variant="ghost" onPress={toggle}>
        {studyLabel(open ? "Hide memory" : "Memory")}
      </Button>
      {open && (
        <View style={styles.memory}>
          <Text style={styles.muted}>
            {studyLabel("Your notes for future chats. Keep private details out. Max 8 KiB.")}
          </Text>
          <EditingTextInput
            key={memory.data?.updatedAt || "loading"}
            multiline
            initialValue={memory.data?.text || ""}
            onChangeText={setText}
            style={styles.memoryInput}
            accessibilityLabel={studyLabel("Study memory")}
          />
          <View style={styles.memoryActions}>
            <Button size="sm" onPress={saveMemory} loading={save.isPending}>
              {studyLabel("Save memory")}
            </Button>
            <Button size="sm" variant="ghost" onPress={clearMemory} loading={clear.isPending}>
              {studyLabel("Clear")}
            </Button>
          </View>
          {(memory.isError || save.isError || clear.isError) && (
            <Text style={styles.error}>
              {studyLabel(
                memory.error?.message || save.error?.message || clear.error?.message || "",
              )}
            </Text>
          )}
        </View>
      )}
    </>
  );
}

interface SpeechResultEvent extends Event {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface BrowserRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  addEventListener(
    type: "result",
    listener: (event: SpeechResultEvent) => void,
    options?: AddEventListenerOptions,
  ): void;
  addEventListener(
    type: "error" | "end",
    listener: () => void,
    options?: AddEventListenerOptions,
  ): void;
}
interface RecognitionWindow extends Window {
  SpeechRecognition?: new () => BrowserRecognition;
  webkitSpeechRecognition?: new () => BrowserRecognition;
}

function dictate(setNotice: (message: string) => void) {
  const Recognition =
    (window as RecognitionWindow).SpeechRecognition ||
    (window as RecognitionWindow).webkitSpeechRecognition;
  if (!Recognition) {
    setNotice("Dictation is unavailable in this browser.");
    return;
  }
  const recognition = new Recognition();
  recognition.lang = localStorage.getItem("study.language") === "en" ? "en-US" : "zh-CN";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.addEventListener(
    "result",
    (event) => {
      const phrase = event.results[0]?.[0]?.transcript;
      const input = document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
      if (!phrase || !input) {
        setNotice(
          phrase ? "Open the message box, then try dictation again." : "No speech was detected.",
        );
        return;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(input, input.value ? `${input.value} ${phrase}` : phrase);
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: phrase }),
      );
      input.focus();
      setNotice("Dictation added. Review the text before sending.");
    },
    { once: true },
  );
  recognition.addEventListener(
    "error",
    () => setNotice("Dictation failed. Check browser microphone access and network."),
    { once: true },
  );
  setNotice("Listening…");
  try {
    recognition.start();
  } catch {
    setNotice("Dictation could not start. Check browser microphone access.");
  }
}

async function readLatestReply(agentId: string, setNotice: (message: string) => void) {
  if (!agentId) return;
  try {
    const response = await fetch(`/study/latest?agentId=${encodeURIComponent(agentId)}`);
    const result = await response.json();
    if (!response.ok) {
      setNotice(result.error || "Could not load the latest reply.");
      return;
    }
    if (!result.text) {
      setNotice("This chat has no reply yet.");
      return;
    }
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      setNotice("Read aloud is unavailable in this browser.");
      return;
    }
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(result.text));
    setNotice(
      "Reading the latest reply. Browser speech may need a network connection and may not work in China.",
    );
  } catch {
    setNotice("Could not connect to the study service.");
  }
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  identity: { flex: 1, minWidth: 160, gap: theme.spacing[1] },
  tools: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  memory: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
  },
  memoryInput: {
    minHeight: 80,
    padding: theme.spacing[2],
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    textAlignVertical: "top",
  },
  memoryActions: { flexDirection: "row", gap: theme.spacing[2] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  form: { gap: theme.spacing[4] },
}));
