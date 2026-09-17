from __future__ import annotations

import asyncio
import os
import shutil
import socket
import sys
import tempfile
import unittest

if os.name != "nt":
    sys.exit("test-windows-runtime.py exercises the native Windows shell path only")

from rlm import bash

bash_module = sys.modules["rlm.bash"]

_BOUND = 30

_CHILD_SCRIPT = """\
import socket, sys

control = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(4)
print(f"PORT={listener.getsockname()[1]}", flush=True)
control.sendall(f"{listener.getsockname()[1]}\\n".encode())
while True:
    data = control.recv(64)
    if not data:
        break
    control.sendall(b"ECHO:" + data)
"""


def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class WindowsBashRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_default_shell_is_native_powershell(self):
        self.assertNotIn("PRIME_AGENT_BASH_SHELL", os.environ)
        self.assertIn(
            os.path.basename(bash_module._shell()).lower(), ("powershell.exe", "pwsh.exe")
        )
        result = await asyncio.wait_for(bash("Write-Output 'native-kernel'"), _BOUND)
        self.assertEqual(result.exit_code, 0)
        self.assertIn("native-kernel", result.output)

    async def test_exit_code_table(self):
        for code in (0, 7):
            result = await asyncio.wait_for(bash(f"exit {code}"), _BOUND)
            self.assertEqual(result.exit_code, code)

    async def test_native_external_process_exit_code(self):
        cmd = bash_module._system32("cmd.exe")
        result = await asyncio.wait_for(bash(f"& {_ps_quote(cmd)} /d /c 'exit 23'"), _BOUND)
        self.assertEqual(result.exit_code, 23)

    async def test_explicit_inbox_powershell_override(self):
        in_box = bash_module._system32("WindowsPowerShell", "v1.0", "powershell.exe")
        self.assertTrue(os.path.isfile(in_box))
        saved = os.environ.get("PRIME_AGENT_BASH_SHELL")
        os.environ["PRIME_AGENT_BASH_SHELL"] = in_box
        try:
            result = await asyncio.wait_for(
                bash("Write-Output ('ps-' + $PSVersionTable.PSVersion.Major)"), _BOUND
            )
        finally:
            if saved is None:
                os.environ.pop("PRIME_AGENT_BASH_SHELL", None)
            else:
                os.environ["PRIME_AGENT_BASH_SHELL"] = saved
        self.assertEqual(result.exit_code, 0)
        self.assertIn("ps-5", result.output)

    async def test_unknown_command_is_nonzero(self):
        result = await asyncio.wait_for(bash("Get-PrimeAgentCommandThatDoesNotExist"), _BOUND)
        self.assertNotEqual(result.exit_code, 0)

    async def test_metacharacters_and_unicode(self):
        expected = "$dollar 'apos' & %percent \"quote\" " + "".join(map(chr, (0x4E2D, 0x6587, 0xE9)))
        command = (
            "Write-Output ('$dollar ''apos'' & %percent \"quote\" '"
            " + [char]0x4E2D + [char]0x6587 + [char]0x00E9)"
        )
        result = await asyncio.wait_for(bash(command), _BOUND)
        self.assertEqual(result.exit_code, 0)
        self.assertIn(expected, result.output)

    async def test_child_env_guards(self):
        result = await asyncio.wait_for(
            bash(
                "[Environment]::GetEnvironmentVariable('GIT_TERMINAL_PROMPT') + '|' + "
                "[Environment]::GetEnvironmentVariable('GIT_TERMINAL_PROMPTS') + '|' + "
                "[Environment]::GetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath') + '|' + "
                "[Environment]::GetEnvironmentVariable('PYTHONUTF8')"
            ),
            _BOUND,
        )
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.output.strip(), "0|0|1|1")
        editor = await asyncio.wait_for(
            bash("[Environment]::GetEnvironmentVariable('GIT_EDITOR')"), _BOUND
        )
        self.assertIn("cmd.exe", editor.output)
        self.assertIn("exit 1", editor.output)

    async def test_cwd_with_spaces_and_unicode(self):
        original = os.getcwd()
        target = tempfile.mkdtemp(prefix="prime kernel ünïcodë ")
        self.addCleanup(shutil.rmtree, target, True)
        self.addCleanup(os.chdir, original)
        os.chdir(target)
        handle = bash("(Get-Location).Path")
        result = await asyncio.wait_for(handle, _BOUND)
        await asyncio.wait_for(handle._wait_reaped(), _BOUND)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(
            os.path.normcase(os.path.realpath(result.output.strip())),
            os.path.normcase(os.path.realpath(target)),
        )

    async def test_concurrent_handles(self):
        handles = [bash(f"Write-Output 'concurrent-{index}'") for index in range(4)]
        results = await asyncio.wait_for(asyncio.gather(*handles), _BOUND)
        await asyncio.wait_for(
            asyncio.gather(*(handle._wait_reaped() for handle in handles)), _BOUND
        )
        for index, result in enumerate(results):
            self.assertEqual(result.exit_code, 0)
            self.assertIn(f"concurrent-{index}", result.output)
        self.assertEqual(len({handle.pid for handle in handles}), 4)

    async def _spawn_marker_child(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.setblocking(False)
        self.addCleanup(listener.close)
        control_port = listener.getsockname()[1]
        handle = bash(f"& {_ps_quote(sys.executable)} {_ps_quote(CHILD_SCRIPT_PATH)} {control_port}")

        async def cleanup_handle():
            handle.kill()
            await asyncio.wait_for(handle._wait_reaped(), _BOUND)

        self.addAsyncCleanup(cleanup_handle)
        loop = asyncio.get_running_loop()
        conn, _ = await asyncio.wait_for(loop.sock_accept(listener), _BOUND)
        conn.setblocking(False)
        self.addCleanup(conn.close)
        port_line = b""
        while b"\n" not in port_line:
            chunk = await asyncio.wait_for(loop.sock_recv(conn, 64), _BOUND)
            self.assertNotEqual(chunk, b"", "control connection closed before the port report")
            port_line += chunk
        return handle, conn, int(port_line.strip())

    async def _assert_peer_dead(self, conn: socket.socket) -> None:
        loop = asyncio.get_running_loop()
        try:
            data = await asyncio.wait_for(loop.sock_recv(conn, 64), _BOUND)
        except OSError:
            return
        self.assertEqual(data, b"")

    async def _assert_peer_alive(self, conn: socket.socket) -> None:
        loop = asyncio.get_running_loop()
        await asyncio.wait_for(loop.sock_sendall(conn, b"ping"), _BOUND)
        data = await asyncio.wait_for(loop.sock_recv(conn, 64), _BOUND)
        self.assertEqual(data, b"ECHO:ping")

    async def test_job_containment_kills_port_holding_descendant(self):
        handle, conn, port = await self._spawn_marker_child()
        probe = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), _BOUND)
        probe[1].close()
        await probe[1].wait_closed()
        handle.kill()
        result = await asyncio.wait_for(handle, _BOUND)
        await asyncio.wait_for(handle._wait_reaped(), _BOUND)
        self.assertNotEqual(result.exit_code, 0)
        self.assertIn(f"PORT={port}", result.output)
        await self._assert_peer_dead(conn)
        with self.assertRaises(OSError):
            await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), _BOUND)

    async def test_one_shot_await_cancellation_kills_child(self):
        handle, conn, _port = await self._spawn_marker_child()
        ready = asyncio.Event()

        async def wait_handle():
            ready.set()
            return await handle

        task = asyncio.create_task(wait_handle())
        await ready.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, _BOUND)
        await self._assert_peer_dead(conn)
        await asyncio.wait_for(handle._wait_reaped(), _BOUND)

    async def test_background_handle_wait_cancellation_leaves_child_alive(self):
        handle, conn, _port = await self._spawn_marker_child()
        self.assertTrue(handle.running)
        ready = asyncio.Event()

        async def wait_handle():
            ready.set()
            return await handle

        task = asyncio.create_task(wait_handle())
        await ready.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, _BOUND)
        await self._assert_peer_alive(conn)
        self.assertTrue(handle.running)
        handle.kill()
        await asyncio.wait_for(handle, _BOUND)
        await asyncio.wait_for(handle._wait_reaped(), _BOUND)
        await self._assert_peer_dead(conn)


_SAVED_ENV: dict[str, str | None] = {}
CHILD_SCRIPT_PATH = ""
_TEMP_DIR = ""


def setUpModule() -> None:
    global CHILD_SCRIPT_PATH, _TEMP_DIR
    _TEMP_DIR = tempfile.mkdtemp(prefix="prime-windows-runtime-")
    CHILD_SCRIPT_PATH = os.path.join(_TEMP_DIR, "marker_child.py")
    with open(CHILD_SCRIPT_PATH, "w", encoding="utf-8") as handle:
        handle.write(_CHILD_SCRIPT)
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    for key in ("PATH", "PRIME_AGENT_BASH_SHELL"):
        _SAVED_ENV[key] = os.environ.get(key)
    os.environ["PATH"] = os.pathsep.join(
        (
            os.path.join(system_root, "System32"),
            os.path.join(system_root, "System32", "WindowsPowerShell", "v1.0"),
            os.path.dirname(sys.executable),
        )
    )
    os.environ.pop("PRIME_AGENT_BASH_SHELL", None)


def tearDownModule() -> None:
    for key, value in _SAVED_ENV.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    shutil.rmtree(_TEMP_DIR, True)


if __name__ == "__main__":
    unittest.main()
