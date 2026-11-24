import { z } from "zod";

export const MAX_NOTE_LENGTH = 2000;

export const NOTE_TOO_LONG = `Note must be ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters or fewer`;

export const noteBodySchema = z
  .string()
  .trim()
  .max(MAX_NOTE_LENGTH, NOTE_TOO_LONG);
