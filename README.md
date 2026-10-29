# Inside My Computer

A macOS system analysis tool built with C, Python, and JavaScript.

**Status: Early prototype — under active development.**

## Overview

Inside My Computer is a project for exploring how macOS works internally.

It combines native system APIs with a Python backend and a browser-based interface to visualize system activity.

## Features

- System and process monitoring
- Thread inspection using macOS native APIs
- Per-thread CPU usage analysis
- Thread CPU Timeline
- Thread State Timeline
- Historical visualization of sampled thread activity

## Technology Stack

| Layer | Technology |
|---|---|
| Native system analysis | C, macOS libproc |
| Backend | Python, FastAPI |
| Frontend | HTML, CSS, JavaScript |
| Visualization | Canvas API |

## Architecture

```text
macOS
  |
  v
C / libproc
  |
  v
Native helper (JSON)
  |
  v
Python / FastAPI
  |
  v
JavaScript / Canvas
  |
  v
Browser Dashboard
```

## Thread State Timeline

The Thread State Timeline visualizes sampled macOS thread states.

- Green: Runnable
- Orange: Waiting
- Red: Uninterruptible
- Gray: Stopped or other states

Thread states are sampled periodically. The visualization does not represent exact state transition times.

An Uninterruptible state is not necessarily an indication of a problem.

## Requirements

- macOS
- Python 3
- Clang / Xcode Command Line Tools
- A modern web browser

## Build the Native Helper

From the project root:

```bash
clang -std=c11 -Wall -Wextra native/libproc_threads_json.c -o native/libproc_threads_json
```

## Installation

Create a Python virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run the application:

```bash
python app.py
```

The startup command may need adjustment depending on the current application configuration.

## Limitations

- macOS only
- Some process information may be restricted by operating system permissions
- Thread state history is based on periodic sampling
- Features and interfaces may change during development

## Roadmap

- CPU and thread-state correlation
- Advanced process and memory analysis
- Network activity inspection
- Performance diagnostics
- Improved installation and packaging

## Project Goal

To build a deeper understanding of operating systems and develop a practical macOS system analysis tool.

Built as an independent learning and engineering project.
