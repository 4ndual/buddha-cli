import * as z from "zod/v4";

export const replaceEditSchema = z.strictObject({
	path: z.string(),
	old_string: z.string(),
	new_string: z.string(),
	replace_all: z.boolean().optional(),
});

export type ReplaceParams = z.output<typeof replaceEditSchema>;

/** Internal batch form produced only by the Cursor exec bridge. */
export interface ReplaceBatchParams {
	path: string;
	edits: Omit<ReplaceParams, "path">[];
}

export const patchEditEntrySchema = z.strictObject({
	op: z.enum(["create", "delete", "update"]).optional(),
	rename: z.string().optional(),
	diff: z.string().optional(),
});

export type PatchEditEntry = z.output<typeof patchEditEntrySchema>;

export const patchEditSchema = z.strictObject({
	path: z.string(),
	edits: z.array(patchEditEntrySchema),
});

export type PatchParams = z.output<typeof patchEditSchema>;

export const applyPatchSchema = z.strictObject({
	input: z.string(),
});

export type ApplyPatchParams = z.output<typeof applyPatchSchema>;

export const hashlineEditParamsSchema = z.strictObject({
	input: z.string(),
});

export type HashlineParams = z.output<typeof hashlineEditParamsSchema>;

export const sloppyEditSchema = z.strictObject({
	input: z.string(),
});

export type SloppyParams = z.output<typeof sloppyEditSchema>;
