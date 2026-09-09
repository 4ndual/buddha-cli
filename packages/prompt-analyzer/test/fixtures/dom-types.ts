/**
 * Minimal DOM shapes for `page.evaluate` bodies.
 *
 * The package tsconfig has no `DOM` lib on purpose (adding it poisons the
 * transitive workspace check), and an ambient `.d.ts` would collide with
 * coding-agent's own browser globals. So each test module declares these
 * names locally — `declare const document: TestDomDocument` inside a module
 * is module-scoped and emits nothing, while the browser supplies the real
 * object at run time.
 */

export interface TestDomElement {
	id: string;
	tagName: string;
	textContent: string | null;
	innerText: string;
	offsetParent: TestDomElement | null;
	hasAttribute(name: string): boolean;
	getAttribute(name: string): string | null;
	querySelector<T extends TestDomElement = TestDomElement>(selectors: string): T | null;
	querySelectorAll(selectors: string): ArrayLike<TestDomElement> & Iterable<TestDomElement>;
	focus(): void;
	click(): void;
}

export interface TestDomDocument extends TestDomElement {
	body: TestDomElement;
	activeElement: TestDomElement | null;
}

export interface TestNavigator {
	clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
}
