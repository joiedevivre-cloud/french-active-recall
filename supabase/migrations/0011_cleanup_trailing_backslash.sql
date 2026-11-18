-- =============================================================================
-- Migration: 0011_cleanup_trailing_backslash
-- Purpose  : One-time cleanup for expressions saved before
--            src/lib/pasteParser.ts stripped markdown's trailing
--            hard-line-break backslash (e.g. "...simple.\"). Only touches
--            rows that actually end in one or more backslashes -- nothing
--            else is modified, and no rows are deleted.
-- =============================================================================

update public.expressions
set expression_fr = regexp_replace(expression_fr, '\\+\s*$', '')
where expression_fr ~ '\\+\s*$';

update public.expressions
set meaning_ko = regexp_replace(meaning_ko, '\\+\s*$', '')
where meaning_ko ~ '\\+\s*$';
