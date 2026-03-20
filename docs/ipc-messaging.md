# Sending Messages via IPC

To send a Telegram message from the host (outside a container), write a JSON file to the group's `messages` directory:

```bash
cat > data/ipc/{group_folder}/messages/msg-$(date +%s).json << 'EOF'
{
  "type": "message",
  "chatJid": "tg:{chat_id}",
  "text": "Your message here"
}
EOF
```

## Common Mistakes

- Type must be `"message"`, NOT `"send_message"`
- Directory must be `messages/`, NOT `tasks/`
- The `tasks/` directory is for scheduled tasks, not direct messages

## Known Group JIDs

- Garsson: `tg:-5128317012` (folder: `telegram_garsson`)
