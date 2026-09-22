import * as z from "zod/v4";

export type ZodWire<S extends z.ZodType> = Record<string, unknown> & { static: z.output<S> };

const wireCache = new WeakMap<z.ZodType, Record<string, unknown>>();

export function zodWire<S extends z.ZodType>(schema: S): ZodWire<S> {
	let wire = wireCache.get(schema);
	if (!wire) {
		wire = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
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
