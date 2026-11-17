-- =============================================================================
-- Migration: 0007_chatgpt_prompt_override
-- Purpose  : Let a user customize the "ChatGPT용 프롬프트 복사" text from
--            Settings. NULL means "use the built-in default"
--            (src/content/chatgpt-prompt.md).
-- =============================================================================

alter table public.user_settings
  add column chatgpt_prompt_override text;
