import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { DefaultResourceLoader, type ExtensionAPI, getAgentDir, initTheme } from "@earendil-works/pi-coding-agent";

export default function artifactExtension(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "artifact-faux",
		models: [{ id: "artifact", reasoning: false, input: ["text", "image"] }],
		tokenSize: { min: 131072, max: 131072 },
	});
	const provider = getApiProvider(faux.api);
	if (!provider) throw new Error("Faux provider was not bundled");
	pi.registerProvider("artifact-faux", {
		api: faux.api,
		apiKey: "offline-test",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: provider.streamSimple,
		models: faux.models,
	});
	if (process.env.PRIME_AGENT_ARTIFACT_CASE === "python") {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: "import os, rlm\nartifact_value = 21\nprint('artifact-python-start')\nprint(os.getpid())\nprint(rlm.__file__)",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: `print('artifact-python-result', artifact_value * 2)\nprint((await bash(${JSON.stringify(process.platform === "win32" ? "Write-Output 'artifact-shell-ok'" : "printf artifact-shell-ok")})).output)`,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				if (results.length !== 2 || results.some((result) => result.isError)) {
					throw new Error(`Python execution failed: ${JSON.stringify(results)}`);
				}
				return fauxAssistantMessage(JSON.stringify(results));
			},
		]);
	} else if (process.env.PRIME_AGENT_ARTIFACT_CASE === "subagent") {
		const respond = (context: Context) => {
			faux.appendResponses([respond]);
			const userMessages = JSON.stringify(context.messages.filter((message) => message.role === "user"));
			if (userMessages.includes("windows-child-task")) return fauxAssistantMessage("windows-child-ok");
			const results = context.messages.filter((message) => message.role === "toolResult");
			if (results.some((result) => result.isError)) {
				throw new Error(`Subagent execution failed: ${JSON.stringify(results)}`);
			}
			if (results.length === 0) {
				return fauxAssistantMessage(
					fauxToolCall("ipython", {
						code: "artifact_child = await rlm.spawn('windows-child-task', name='windows-child')\nprint(artifact_child.name)",
					}),
					{ stopReason: "toolUse" },
				);
			}
			if (results.length === 1) {
				return fauxAssistantMessage(
					fauxToolCall("ipython", {
						code: "artifact_children = await rlm.collect([artifact_child], timeout_ms=30000)\nassert len(artifact_children) == 1\nassert artifact_children[0].settled\nassert artifact_children[0].error is None\nassert 'windows-child-ok' in (artifact_children[0].answer_preview or '')\nprint('artifact-subagent-ok')\nawait rlm.delete_subagent(artifact_child)",
					}),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage(JSON.stringify(results));
		};
		faux.setResponses([respond]);
	} else {
		faux.setResponses([
			(context) => {
				if (process.env.PRIME_AGENT_ARTIFACT_CASE === "image") {
					if (!JSON.stringify(context.messages).includes("original 3000x1, displayed at 2000x1")) {
						throw new Error("Photon did not resize the attached image");
					}
				}
				return fauxAssistantMessage(`artifact-ok:${"x".repeat(131072)}:complete`);
			},
		]);
	}
	pi.on("session_start", async () => {
		initTheme("prime");
		const resources = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			noExtensions: true,
			noContextFiles: true,
		});
		await resources.reload();
		const skills = resources.getSkills().skills;
		if (
			!skills.length ||
			skills.some((skill) => !skill.filePath.startsWith(join(dirname(process.execPath), "skills")))
		) {
			throw new Error("Bundled skills did not resolve from the extracted archive");
		}
		writeFileSync(
			join(process.cwd(), "loaded-assets.json"),
			JSON.stringify({ skills: skills.map((skill) => skill.name) }),
		);
	});
}
