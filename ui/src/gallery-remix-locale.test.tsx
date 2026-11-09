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

const source = {
	id: "site-shared",
	kind: "duplicate",
	name: "Mein Shop",
} as const;

function dialog(copy: string) {
	return (
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="de"
			manageDocument={false}
			overlays={{ de: { "{name} copy": copy } }}
		>
			<RemixSiteDialog
				busy={false}
				onCreated={async () => undefined}
				onOpenChange={() => undefined}
				run={async (work) => work()}
				source={source}
			/>
		</I18nProvider>
	);
}

function nameInput() {
	const input = document.body.querySelector<HTMLInputElement>("input");
	if (!input) {
		throw new Error("Missing name input");
	}
	return input;
}

test("the duplicate dialog suggests a translated name and keeps typed text when the catalog changes", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(dialog("{name} (Kopie)")));
	expect(nameInput().value).toBe("Mein Shop (Kopie)");

	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		const input = nameInput();
		setValue?.call(input, "Mein Laden");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(nameInput().value).toBe("Mein Laden");

	// A late catalog (a pack update or a hosted answer) must not reset the field.
	await act(async () => root.render(dialog("Kopie von {name}")));
	expect(nameInput().value).toBe("Mein Laden");

	await act(async () => root.unmount());
	container.remove();
});
