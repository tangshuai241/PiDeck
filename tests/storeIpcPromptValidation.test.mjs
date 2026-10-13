import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function register(promptManager, projectResourceManager = {}, options = {}) {
	const handlers = new Map();
	const electron = {
		ipcMain: {
			handle(channel, handler) {
				handlers.set(channel, handler);
			},
		},
	};
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts", {
		stubs: { electron },
	});
	registerStoreIpc({
		promptManager,
		skillManager: {},
		xuePromptManager: {},
		projectResourceManager,
		configManager: options.configManager,
		projectTrustPath: options.projectTrustPath,
		extensionManager: options.extensionManager ?? {},
		appLogger: {
			info: async () => {},
			warn: async () => {},
		},
		mainCopy: (key) => key,
	});
	return { handlers, ipcChannels };
}

test("prompt IPC rejects malformed global and project payloads before manager calls", async () => {
	let managerCalls = 0;
	const failIfCalled = () => {
		managerCalls += 1;
		throw new Error("manager should not be called");
	};
	const { handlers, ipcChannels } = register(
		{
			create: failIfCalled,
			delete: failIfCalled,
			writeContent: failIfCalled,
			readContent: failIfCalled,
			rename: failIfCalled,
			toggle: failIfCalled,
			createInProject: failIfCalled,
		},
		{ getProjectRoot: failIfCalled },
	);

	await assert.rejects(handlers.get(ipcChannels.promptsCreate)({}, 42), /Invalid prompt input/);
	await assert.rejects(handlers.get(ipcChannels.promptsCreate)({}, { name: "valid", description: 42 }), /Invalid prompt description/);
	await assert.rejects(handlers.get(ipcChannels.promptsDelete)({}, 42), /Invalid prompt path/);
	await assert.rejects(handlers.get(ipcChannels.promptsEdit)({}, "C:/prompt.md", { invalid: true }), /Invalid prompt content/);
	await assert.rejects(handlers.get(ipcChannels.promptsRename)({}, "old", 42), /Invalid new prompt name/);
	await assert.rejects(handlers.get(ipcChannels.promptsToggle)({}, "C:/prompt.md", "yes"), /Invalid prompt toggle input/);
	await assert.rejects(handlers.get(ipcChannels.promptsCreateInProject)({}, "p".repeat(257), { name: "valid", description: "description" }), /Invalid project id/);
	assert.equal(managerCalls, 0);
});

test("prompt IPC accepts an empty description string and leaves required-field policy to the manager", async () => {
	let captured;
	const { handlers, ipcChannels } = register({
		create: async (input) => {
			captured = input;
			return { name: input.name, description: input.description, path: "C:/prompt.md", content: "", userCreated: true };
		},
	});

	await handlers.get(ipcChannels.promptsCreate)({}, { name: "valid", description: "" });
	assert.equal(captured.name, "valid");
	assert.equal(captured.description, "");
});
