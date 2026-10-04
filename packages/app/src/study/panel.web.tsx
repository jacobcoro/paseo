import { useCallback, useEffect, useMemo, useReducer, useState, type Dispatch } from "react";
import { useRouter, usePathname } from "expo-router";
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
  const display = useMemo(
    () => options.find((item) => item.value === value) || null,
    [options, value],
  );
  const change = useCallback(
    (next: string) => dispatch({ type: "change", patch: { [name]: next } }),
    [name, dispatch],
  );
  return (
    <SelectField
      label={label}
      value={value}
      selectedDisplay={display}
      options={options}
      placeholder="选择 / Select"
      emptyText="暂无记录 / No records"
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
    <Field label={label}>
      <FormTextInput
        accessibilityLabel={label}
        initialValue={value}
        onChangeText={change}
        multiline
        size="sm"
      />
    </Field>
  );
}
function ResearchSheet({ close }: { close: () => void }) {
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
    <AdaptiveModalSheet visible header={SHEET_HEADER} onClose={close} desktopMaxWidth={600}>
      <View style={styles.form}>
        <StudySelect
          name="promptId"
          label="记录对应的提示词 / Prompt"
          value={state.form.promptId}
          options={prompts}
          dispatch={dispatch}
        />
        <StudySelect
          name="phase"
          label="设计阶段 / Phase"
          value={state.form.phase}
          options={phases}
          dispatch={dispatch}
        />
        {fields.map(({ key, label }) => (
          <StudyTextField
            key={key}
            name={key}
            label={label}
            value={state.form[key]}
            dispatch={dispatch}
          />
        ))}
        <StudySelect
          name="modified"
          label="是否修改 AI 结果 / Modified?"
          value={state.form.modified}
          options={modified}
          dispatch={dispatch}
        />
        <StudySelect
          name="adoption"
          label="最终是否采用 / Adoption"
          value={state.form.adoption}
          options={adoption}
          dispatch={dispatch}
        />
        {records.isError && <Text style={styles.error}>{records.error.message}</Text>}
        {save.isError && <Text style={styles.error}>{save.error.message}</Text>}
        {state.saved && <Text style={styles.text}>已保存 / Saved</Text>}
        <Text style={styles.muted}>
          {records.data?.annotations.length || 0} 条记录已保存 / records saved
        </Text>
        <Button onPress={submit} loading={save.isPending}>
          保存记录 / Save record
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

export function StudyPanel() {
  const [open, setOpen] = useState(false);
  const student = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 2000,
    queryKey: ["study-student"],
    queryFn: async () => Student.parse(await getJson("/study/me")),
  });
  const router = useRouter();
  const pathname = usePathname();
  const connected = useHostRuntimeIsConnected(student.data?.serverId || "");
  useEffect(() => {
    if (!student.data || !connected || !["/", "/welcome", "/open-project"].includes(pathname))
      return;
    router.replace({
      pathname: "/h/[serverId]/agent/[agentId]",
      params: { serverId: student.data.serverId, agentId: student.data.agentId },
    });
  }, [student.data, connected, pathname, router]);
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
  if (!student.data) return null;
  const modeLabel =
    student.data.mode === "fixture" ? "演示 · 固定回答 / Fixture demo" : "Codex · Live";
  return (
    <>
      <View style={styles.banner}>
        <View style={styles.identity}>
          <Text style={styles.text}>Lulu · {student.data.studentId}</Text>
          <Text style={styles.muted}>{modeLabel}</Text>
        </View>
        <Button size="sm" onPress={openSheet}>
          研究记录 / Record
        </Button>
        <Button size="sm" variant="ghost" onPress={exportRecords}>
          导出 / Export
        </Button>
        <Button size="sm" variant="ghost" loading={logout.isPending} onPress={signOut}>
          退出 / Sign out
        </Button>
      </View>
      {logout.isError && <Text style={styles.error}>{logout.error.message}</Text>}
      {open && <ResearchSheet close={closeSheet} />}
    </>
  );
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
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  form: { gap: theme.spacing[4] },
}));
