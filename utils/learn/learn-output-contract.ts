/** Shared by generation and submission; applies only to newly learned skills. */
export const LEARN_SKILL_SECTIONS = [
  '目标', '前置条件', '完成计划', '具体操作讲解', '分支与坑点', '完成判定', '边界',
] as const;

/** Check structure without pretending to verify the semantic truth of model output. */
export function validateLearnSkillBody(body: string): string[] {
  const issues: string[] = [];
  if (/\banx:\d+:[a-f\d-]+:\d+\b|\bax:\d+:axs:/i.test(body))
    issues.push('正文不得保存运行期 DOM/AX 引用；改写为可重新采集的定位方式');
  if (/^\s*---\s*\n/.test(body)) issues.push('body 不应包含 frontmatter');
  // Ignore fenced examples: quoted sample headings cannot satisfy the contract.
  const structuralBody = body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
  const headings = Array.from(structuralBody.matchAll(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/gm));
  let previous = -1;
  for (const title of LEARN_SKILL_SECTIONS) {
    const index = headings.findIndex(match => match[1] === title);
    if (index < 0) issues.push(`缺少二级标题：## ${title}`);
    else if (headings.filter(match => match[1] === title).length > 1) issues.push(`二级标题重复：## ${title}`);
    else if (index <= previous) issues.push(`二级标题顺序不正确：## ${title}`);
    else previous = index;
  }
  const contentOf = (title: string): string => {
    const index = headings.findIndex(match => match[1] === title);
    if (index < 0) return '';
    return structuralBody.slice(headings[index].index! + headings[index][0].length, headings[index + 1]?.index ?? structuralBody.length);
  };
  for (const title of LEARN_SKILL_SECTIONS) {
    if (headings.some(match => match[1] === title) && !contentOf(title).trim()) issues.push(`小节为空：${title}`);
  }
  const plan = Array.from(contentOf('完成计划').matchAll(/^\s*(\d+)[.)、]\s*\S/gm), match => Number(match[1]));
  const steps = Array.from(contentOf('具体操作讲解').matchAll(/^###\s+(\d+)[.)、]\s*\S/gm), match => Number(match[1]));
  if (!plan.length || !steps.length || plan.length !== steps.length || plan.some((n, i) => n !== i + 1 || steps[i] !== n)) {
    issues.push('完成计划须按 1.、2. 编号；具体操作讲解须按 ### 1.、### 2. 逐项对应，编号连续且数量一致');
  }
  return issues;
}
