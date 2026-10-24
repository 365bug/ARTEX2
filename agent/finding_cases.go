package agent

import (
	"context"
	actool "github.com/Autumn-27/norma/tool"
)

type findingReviewKey struct{}

// Historical consolidation has a narrower capability set than new reporting.
func WithFindingCaseReview(ctx context.Context) context.Context {
	return context.WithValue(ctx, findingReviewKey{}, true)
}
func isFindingCaseReview(ctx context.Context) bool {
	v, _ := ctx.Value(findingReviewKey{}).(bool)
	return v
}

func historicalFindingCaseTools(tools []actool.CoreTool) []actool.CoreTool {
	allowed := map[string]bool{}
	for _, name := range []string{"search_finding_duplicates", "get_finding_record", "merge_finding_records", "suggest_finding_merge", "get_finding_case", "update_finding_case_report", "complete_finding_case_review", "get_finding_traffic", "traffic_search", "traffic_get", "traffic_blob", "get_task_node_detail", "list_task_findings", "get_task_graph", "list_task_worker_traces", "get_task_worker_trace", "Read"} {
		allowed[name] = true
	}
	out := make([]actool.CoreTool, 0, len(tools))
	for _, tool := range tools {
		if allowed[tool.Name()] {
			out = append(out, tool)
		}
	}
	return out
}

// This guidance is appended to the runtime prompt, including editable old prompts.
// Never reintroduce unbound tools or recreate a deleted Reporter.
func findingCaseWorkflow(key string, tools []actool.CoreTool) ([]actool.CoreTool, string) {
	if key != "reporter" {
		return tools, ""
	}
	has := map[string]bool{}
	for _, t := range tools {
		has[t.Name()] = true
	}
	if !has["search_finding_duplicates"] || !has["merge_finding_records"] || !has["get_finding_case"] || !has["update_finding_case_report"] {
		return tools, ""
	}
	return tools, `

【同一漏洞的多次上报整理】保留本次独立报告，不覆盖其他原报告。默认报告完成即停止的旧指引在此扩展：先保存本次报告，然后 search_finding_duplicates(finding_id=独立记录ID) 分页读取同任务候选摘要（按 score 排序；strong=同漏洞类型且资产重叠，优先核对；weak=单一条件命中，仅作参考），按需 get_finding_record 查看证据。仅凭漏洞类型/标题相似或高中低等级不能归并；须核对目标、接口、参数、权限边界、根因及实际验证证据。
【判断准则】有证据表明端点/路由、处理器或后端组件、易受影响参数、缺失检查属于不同代码路径时，可以判定 independent；但仅凭路径、接口、登录入口、令牌、标题或漏洞类型相同/不同都不能证明根因。比较实际缺失的鉴权检查、对象权限边界、会话门或共同组件，并引用每条记录中的具体证据。只有根因明确相同才用 merge_finding_records；只有存在具体共同点（同端点/参数/组件/缺失检查）但缺关键证据确认时才用 suggest_finding_merge，并一次提交覆盖2..20条记录的分组，禁止仅因类型或资产相同而建议。没有具体共同点就保持 independent，不要因不确定而建议。不重复上报、不删除记录、不重新探测目标。人工选择整理时只能判断所选记录，不能加入未选记录（既有组成员可作为报告上下文）。
归并不以统一报告为前提：根因明确就先归并，统一报告可随后补齐（未完成时文件夹显示“统一报告待更新”）。归并成功或已有case_id时，get_finding_case 记录实际version，分页读取全部成员，按需get_finding_record、get_finding_traffic读取原报告、PoC及已保存流量。update_finding_case_report保存完整统一报告（包含有内容的概述、影响、前置条件、复现步骤、证据、PoC、根因分析、修复建议章节，不得半篇截断）和基于已验证影响的severity及severity_reason；不能直接取成员最高等级。集中给出前置条件、完整执行顺序、输入输出如何衔接、可运行的完整脚本及命令，不把必要步骤分散到原报告；缺失条件、未验证步骤如实标明。版本冲突重新读取材料并生成，不能仅换version重试。各成员仍有独立报告、评级和证据。没有明确重复则保留独立记录。工具被关闭时不绕过配置。`
}

const historicalFindingReviewGuidance = `

【历史整理模式，优先于旧报告撰写及自动绑流量指引】本次只整理已经存在的上报。原始报告即使为空或待更新，也只记录缺失情况，绝不调用 update_finding_report、report_finding、bind_finding_traffic，不修改原始标题、评级、状态、证据或报告，不执行 Bash、写文件或重新探测目标。
先逐条 get_finding_record 读取所选记录，已有原报告直接作为判断材料复用，不重复撰写。只在所选范围内检查同一实际缺陷，可按需读取已存在的证据。按上述根因准则形成明确归并/独立/疑似建议；仅当存在具体共同点（同端点/参数/组件/缺失检查）但缺关键证据时才保存疑似建议供人工确认，没有具体共同点的不确定情况保持 independent。
已有或新建文件夹应读取全部成员并尽力用 update_finding_case_report 写入完整、最新的统一报告；归并不因报告暂缺而阻塞，未完成时文件夹会显示“统一报告待更新”，可由后续运行或人工补齐。统一报告是单独的材料，不覆盖原报告。最后必须调用 complete_finding_case_review，为每条所选 finding_id 提交 verdict（independent/merged/suggested）、reason 和 root_cause_evidence，并提供总结。根因证据应说明具体相同/不同的检查及证据来源；疑似建议明确待补证据。服务端验收通过后才可宣布完成。工具不可用或验收失败时如实报告，不能只用自然语言声称完成。`
