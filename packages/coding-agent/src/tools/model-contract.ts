import type { Context } from "@oh-my-pi/pi-ai";

export const CODE_ONLY_TOOL_NAMES = new Set(["read", "edit", "write", "bash", "ask", "eval", "task", "hub"]);

export function projectModelToolContext(context: Context): Context {
	if (!context.tools?.some(tool => CODE_ONLY_TOOL_NAMES.has(tool.name))) return context;
	return {
		...context,
		tools: context.tools.map(tool =>
			CODE_ONLY_TOOL_NAMES.has(tool.name)
				? new Proxy(tool, {
						get(target, key) {
							if (key === "description") return "";
							if (key === "examples") return undefined;
							return Reflect.get(target, key, target);
						},
					})
				: tool,
		),
	};
}
