#!/bin/sh
# Mock Agent CLI for Testing
echo "Welcome to Mock-AI v1.0"
echo "Initializing..."
sleep 1
printf "AI-GUEST > "

while read line; do
  if [ "$line" = "exit" ]; then
    echo "Goodbye!"
    exit 0
  fi
  echo "Thinking about: $line..."
  sleep 1
  echo "Response: I have processed your request for '$line'."
  printf "AI-GUEST > "
done
