#!/usr/bin/env python
r"""
LLaMA-Factory 命令行入口（替代 llamafactory-cli.exe）

为什么需要这个：
  pip 生成的 llamafactory-cli.exe 需要先 pip install -e，而 editable 安装
  要用 hatchling 构建后端，云端环境不一定有，还可能有别的构建依赖。
  改用 .pth 把源码目录挂到 site-packages 之后，import 能直接工作，
  但没有 .exe 入口，所以用这个脚本代替。

用法（跟 llamafactory-cli 完全一样）：
  python train\lf.py train train\stage1-wisdom.yaml dataset_dir=data ...
  python train\lf.py export ...
  python train\lf.py --help
"""
import os
import sys

# 1) 如果同目录下有 vendor 源码（环境包里），优先用它
_here = os.path.dirname(os.path.abspath(__file__))
for _cand in (
    os.path.join(_here, "vendor", "LLaMA-Factory", "src"),
    os.path.join(_here, "..", "vendor", "LLaMA-Factory", "src"),
):
    _cand = os.path.abspath(_cand)
    if os.path.isdir(os.path.join(_cand, "llamafactory")):
        if _cand not in sys.path:
            sys.path.insert(0, _cand)
        break

# 2) 否则依赖 site-packages 里的 .pth 挂载
try:
    import llamafactory  # noqa: F401
except ImportError:
    sys.stderr.write(
        "\n[错误] 找不到 llamafactory\n\n"
        "  说明环境还没装好。请先运行环境包里的：\n"
        "    1. 安装环境.bat    （装 PyTorch）\n"
        "    2. 修复安装.bat    （挂载 LLaMA-Factory 源码 + 装依赖）\n\n"
    )
    sys.exit(1)

from llamafactory.cli import main

if __name__ == "__main__":
    main()
