/**
 * Types for presentation mode (spec §8.6).
 *
 * The masking functions are declared to PRESERVE a missing value rather than mask it: "we do not
 * know who this is" and "we are not telling you" are different facts, and the overloads keep them
 * distinguishable in the type system as well as at runtime.
 */

/** Is presentation mode on right now? */
export declare function isPresenting(): boolean;

/** Turn it on or off, and announce the change on `document` as `mermaid:presenting`. */
export declare function setPresenting(on: boolean): void;

/**
 * A person's name, masked to initials while presentation mode is on ("Sasha Mockfile" → "S.M.").
 * An absent name is returned unchanged.
 */
export declare function maskName<T extends string | null | undefined>(name: T): T;

/**
 * An identifier reduced to its last two characters while presentation mode is on. Not blanked:
 * a member ID is shared across a policy, and two rows masked to the same string cannot be worked.
 */
export declare function maskId<T extends string | null | undefined>(id: T): T;

/** A button that toggles the mode, owning its own wording and pressed state. */
export declare function presentingToggle(): HTMLButtonElement;
