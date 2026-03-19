#!/bin/bash
set -e
echo "Installing ffmpeg..."
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg
ffmpeg -version | head -1
echo "ffmpeg installed successfully"
