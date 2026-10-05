export const htmlLanguageScript = `<script>
(()=>{
const pairs=[['设计过程研究','Design study'],['学生编号','Student ID'],['密码','Password'],['登录','Sign in'],['研究结果','Research results'],['管理员只读视图','Read-only researcher view'],['导出全部','Download all'],['退出','Sign out'],['学生','Students'],['提示词','Prompts'],['待填写反思','Missing reflections'],['图片','Images'],['文件','Documents'],['尚未开始对话','No conversation yet'],['尚未提交反思','No reflections submitted'],['生成图片','Generated images'],['上传图片','Submitted images'],['研究记录','Research notes'],['模型与推理设置','Model and reasoning changes'],['阶段','Phase'],['任务','Task'],['AI 目的','Purpose'],['下一步','Next action'],['修改','Modified'],['采用','Adoption'],['用途','Final use'],['使用学生编号登录。对话与研究记录自动保存。','Sign in with your student ID.'],['编号或密码不正确','Invalid student ID or password']];
const labels=new Map();for(const pair of pairs){for(const value of [...pair,pair.join(' / ')])labels.set(value,pair)}
labels.set('使用学生编号登录。对话与研究记录自动保存。Sign in with your student ID.',pairs[pairs.length-2]);
const language=()=>localStorage.getItem('study.language')==='en'?'en':'zh-CN';
const button=document.createElement('button');button.type='button';button.id='study-language';button.style.cssText='width:auto;margin:0 0 12px;padding:8px 12px';
(document.querySelector('header .actions')||document.querySelector('main')).prepend(button);
function apply(){document.documentElement.lang=language();const toggleLabel=language()==='en'?'中文':'English';if(button.textContent!==toggleLabel)button.textContent=toggleLabel;const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let text;while(text=walk.nextNode()){if(text.parentElement.closest('pre,script,style,#study-language'))continue;const pair=labels.get(text.textContent.trim());if(pair){const next=pair[language()==='en'?1:0];if(text.textContent!==next)text.textContent=next}}}
button.onclick=()=>{localStorage.setItem('study.language',language()==='en'?'zh-CN':'en');apply()};
new MutationObserver(apply).observe(document.body,{childList:true,subtree:true,characterData:true});apply();
})();
</script>`;
