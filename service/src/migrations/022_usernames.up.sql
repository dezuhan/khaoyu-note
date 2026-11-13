-- Existing accounts predate usernames. Give each one a unique, stable handle so invitations can
-- address it by username; new accounts always receive a validated username in the application.
UPDATE accounts
SET username = 'user_' || substr(replace(id, '-', ''), 1, 12)
WHERE username IS NULL;
