import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Another file may have left happy-dom registered; only own what we start.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { RemixSiteDialog } = await import("./gallery.tsx");

afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
});

const overlays = {
	de: {
		"Duplicate site": "Website duplizieren",
		"Remix site": "Website remixen",
	},
};

async function renderTitle(kind: "duplicate" | "remix") {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	// The DOM localizer is off, so only text rendered through tl() is German.
	await act(async () =>
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				manageDocument={false}
				overlays={overlays}
			>
				<RemixSiteDialog
					busy={false}
					onCreated={async () => undefined}
					onOpenChange={() => undefined}
					run={async (work) => work()}
					source={{ id: "site-shared", kind, name: "Mein Shop" }}
				/>
			</I18nProvider>
		)
	);
	const title = document.body.querySelector("h2")?.textContent ?? "";
	const buttons = [...document.body.querySelectorAll("button")].map(
		(button) => button.textContent ?? ""
	);
	await act(async () => root.unmount());
	container.remove();
	return { buttons, title };
}

test("the duplicate dialog title and confirm button are translated on first render", async () => {
	const { buttons, title } = await renderTitle("duplicate");
	expect(title).toBe("Website duplizieren");
	expect(buttons).toContain("Website duplizieren");
	expect(buttons).not.toContain("Duplicate site");
});

test("the remix dialog title and confirm button are translated on first render", async () => {
	const { buttons, title } = await renderTitle("remix");
	expect(title).toBe("Website remixen");
	expect(buttons).toContain("Website remixen");
	expect(buttons).not.toContain("Remix site");
});
