-- A suspected-spam contact message is kept, not discarded: it is stored with
-- `spam = true`, never forwarded to the board's inbox, and shown on its own
-- tab at /admin/kontakt, so a false positive is something the board can see
-- and release instead of something nobody ever learns about. The detector
-- is heuristic; the only way to judge how often it misfires is to keep what
-- it caught.
--
-- `spam_reasons` records which rules fired (codes from lib/spamHeuristics.ts
-- and the form-token check). It stays after a message is released with "Kein
-- Spam", on purpose: that is exactly the trail that shows which rule was
-- wrong.
--
-- Both columns are additive with a default, so the previous release of the
-- code keeps inserting rows without naming either of them.
alter table contact_messages add column if not exists spam boolean not null default false;
alter table contact_messages add column if not exists spam_reasons text[] not null default '{}';

-- The admin page asks for one tab at a time, newest first.
create index if not exists contact_messages_spam_created_at_idx
  on contact_messages (spam, created_at desc);
