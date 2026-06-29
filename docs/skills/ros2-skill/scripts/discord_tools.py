#!/usr/bin/env python3
"""
CLI tool for Discord integration: send images to a Discord channel.

Usage:
  python3 scripts/discord_tools.py send-image --path <image_path> --channel-id <channel_id> --config <config_path> [--delete]

Config file structure:
  {
    "channels": {
      "discord": {
        "token": "YOUR_DISCORD_BOT_TOKEN"
      }
    }
  }

Arguments:
  --config: Path to nanobot config file (e.g., ~/.nanobot/config.json)
  --channel-id: Discord channel ID (provided by nanobot agent dynamically)
"""
import argparse
import json
import os
import sys
import requests

def load_config(config_path):
    """Load nanobot config from the specified config file path."""
    config_path = os.path.expanduser(config_path)
    
    if not os.path.exists(config_path):
        print(f"Error: Config file not found at {config_path}", file=sys.stderr)
        sys.exit(1)
    
    try:
        with open(config_path, 'r') as f:
            config = json.load(f)
        
        # Validate config structure: channels.discord.token
        if "channels" not in config:
            print("Error: Config missing 'channels' section", file=sys.stderr)
            sys.exit(1)
        
        if not isinstance(config["channels"], dict):
            print("Error: Config 'channels' section must be a dictionary", file=sys.stderr)
            sys.exit(1)
        
        if "discord" not in config["channels"]:
            print("Error: Config 'channels' section missing 'discord' key", file=sys.stderr)
            sys.exit(1)
        
        if not isinstance(config["channels"]["discord"], dict):
            print("Error: Config 'channels.discord' must be a dictionary", file=sys.stderr)
            sys.exit(1)
        
        if "token" not in config["channels"]["discord"]:
            print("Error: Config 'channels.discord' section missing 'token' key", file=sys.stderr)
            sys.exit(1)
        
        if not config["channels"]["discord"]["token"]:
            print("Error: Config 'channels.discord.token' is empty", file=sys.stderr)
            sys.exit(1)
        
        return config
        
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in config file: {e}", file=sys.stderr)
        sys.exit(1)
    except IOError as e:
        print(f"Error reading config file: {e}", file=sys.stderr)
        sys.exit(1)

def send_image(path, channel_id, config_path, delete_after):
    config = load_config(config_path)
    token = config["channels"]["discord"]["token"]
    
    if not channel_id:
        print("Error: --channel-id argument is required", file=sys.stderr)
        sys.exit(1)
    
    if not os.path.exists(path):
        print(f"Error: File not found: {path}", file=sys.stderr)
        sys.exit(1)
    
    url = f"https://discord.com/api/v10/channels/{channel_id}/messages"
    headers = {"Authorization": f"Bot {token}"}
    
    with open(path, "rb") as f:
        files = {"file": (os.path.basename(path), f)}
        response = requests.post(url, headers=headers, files=files)
    
    if response.status_code == 200 or response.status_code == 201:
        print(f"Image sent to Discord channel {channel_id} successfully.")
        if delete_after:
            os.remove(path)
            print(f"Deleted image: {path}")
    else:
        print(f"Error sending image: {response.status_code} {response.text}", file=sys.stderr)
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description="Discord tools for ros2-skill")
    subparsers = parser.add_subparsers(dest="command")

    send_parser = subparsers.add_parser("send-image", help="Send image to Discord channel")
    send_parser.add_argument("--path", required=True, help="Path to image file")
    send_parser.add_argument("--channel-id", required=True, help="Discord channel ID (provided by agent)")
    send_parser.add_argument("--config", required=True, help="Path to nanobot config file (e.g., ~/.nanobot/config.json)")
    send_parser.add_argument("--delete", action="store_true", help="Delete image after sending")

    args = parser.parse_args()
    if args.command == "send-image":
        send_image(args.path, args.channel_id, args.config, args.delete)
    else:
        parser.print_help()
        sys.exit(1)

if __name__ == "__main__":
    main()
