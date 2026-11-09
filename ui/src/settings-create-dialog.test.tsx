import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

// The closed Template trigger shows the Gallery's template name. A bare
// <SelectValue /> without `items` printed the raw id ("help-center").

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { CreateSiteDialog } = await import("./settings-create-dialog.tsx");

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => {
			root.unmount();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		container.remove();
	}
});

async function templateTrigger(
	initialTemplate: "dashboard" | "help-center",
	overlays: Record<string, Record<string, string>> = {}
): Promise<string> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={Object.keys(overlays)[0] ?? "en"}
				initialPackId={null}
				manageDocument={false}
				overlays={overlays}
			>
				<CreateSiteDialog
					busy={false}
					initialTemplate={initialTemplate}
					onCreate={async () => undefined}
					open
					run={async (work) => work()}
					setOpen={() => undefined}
				/>
			</I18nProvider>
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const trigger = document.querySelector('[aria-label="Template"]');
	if (!trigger) {
		throw new Error("the Template trigger did not render");
	}
	return trigger.textContent ?? "";
}

test("the template trigger shows the template name, not its id", async () => {
	const text = await templateTrigger("dashboard");
	expect(text).toContain("Request tracker");
	expect(text).not.toContain("dashboard");
});

test("the template name follows the UI language", async () => {
	const text = await templateTrigger("help-center", {
		de: { "Help center": "Hilfecenter" },
	});
	expect(text).toContain("Hilfecenter");
	expect(text).not.toContain("help-center");
});
