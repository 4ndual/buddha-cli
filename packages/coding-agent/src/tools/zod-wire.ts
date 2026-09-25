import * as z from "zod/v4";

export type ZodWire<S extends z.ZodType> = Record<string, unknown> & { static: z.output<S> };

const wireCache = new WeakMap<z.ZodType, Record<string, unknown>>();
const schemaAnnotations = new Set(["description", "title", "examples", "$comment"]);

function withoutSchemaAnnotations(value: unknown, namesAreProperties = false): unknown {
	if (Array.isArray(value)) return value.map(item => withoutSchemaAnnotations(item));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => namesAreProperties || !schemaAnnotations.has(key))
			.map(([key, item]) => [
				key,
				withoutSchemaAnnotations(item, key === "properties" || key === "$defs" || key === "patternProperties"),
			]),
	);
}

export function zodWire<S extends z.ZodType>(schema: S): ZodWire<S> {
	let wire = wireCache.get(schema);
	if (!wire) {
		wire = withoutSchemaAnnotations(z.toJSONSchema(schema, { io: "input" })) as Record<string, unknown>;
		wireCache.set(schema, wire);
	}
	return wire as ZodWire<S>;
}

export const ToolResultOutput = z.looseObject({
	content: z.array(
		z.union([
			z.looseObject({ type: z.literal("text"), text: z.string() }),
			z.looseObject({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
		]),
	),
	isError: z.boolean().optional(),
});
