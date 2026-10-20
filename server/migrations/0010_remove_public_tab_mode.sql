-- Retire the public mode once; runtime and API only support direct and custom.
-- Preserve saved addresses, unrelated settings, and their existing timestamps.
UPDATE service_settings
SET value_json = json_set(value_json, '$.mode', 'direct')
WHERE setting_key = 'cursor_tab'
  AND CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.mode') END = 'public';
