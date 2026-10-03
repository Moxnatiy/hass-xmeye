"""One log for both halves of the integration.

A tile that blinks on refresh is a question about ordering: did the server send
late, or did the browser draw late? Answering it from two separate logs means
lining up two clocks by eye, and the interesting window is a few hundred
milliseconds wide. So both sides write here instead, into one file, in the order
things actually happened:

    12.483 web   wall        start, 3 channels
    12.501 back  mux         session opened
    13.042 back  channel 0   announced 704x576 h265 after 0.54s
    13.055 web   channel 0   first frame

Off by default. It is a debugging instrument, not telemetry: nothing is written
until someone turns it on in the panel, and nothing leaves the machine — the file
sits beside the Home Assistant configuration.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

#: Beside configuration.yaml, where the other Home Assistant logs live.
LOG_NAME = "xmeye-debug.log"

#: Rotated at this size, keeping one previous file. A wall of sixteen writes a
#: few lines a second at most, so this is hours of history and a bounded disk.
MAX_BYTES = 4 * 1024 * 1024

#: Where the switch and the writer live between requests.
STORE = f"{DOMAIN}_debuglog"


class DebugLog:
    """Appends lines from either side, on one clock."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.path = Path(hass.config.path(LOG_NAME))
        #: The switch outlives a restart. Half the faults worth recording are
        #: the ones that need Home Assistant restarted to provoke, and having to
        #: turn the log back on afterwards means missing exactly those.
        self.marker = Path(hass.config.path(f"{LOG_NAME}.on"))
        self.enabled = self.marker.exists()
        #: Everything is timed from here, so web and back share an origin rather
        #: than two clocks that agree only to the second. Both forms are kept:
        #: monotonic for the server's own events, because it cannot be moved by
        #: a time sync mid-recording, and wall time to place the browser's.
        self.started = time.monotonic()
        self.started_epoch = time.time()
        #: Lines waiting for the writer thread. See :meth:`_hold`.
        self._pending: list[str] = []
        self._writing = False

    def turn(self, on: bool) -> None:
        if on and not self.enabled:
            self.started = time.monotonic()
            self.started_epoch = time.time()
            self._hold(f"{'':>8} ---- log opened ----")
        self.enabled = on
        self.hass.async_create_background_task(self._switch(on), name="xmeye-debuglog-switch")

    async def _switch(self, on: bool) -> None:
        await self.hass.async_add_executor_job(self._mark, on)

    def _mark(self, on: bool) -> None:
        try:
            if on:
                self.marker.touch()
            else:
                self.marker.unlink(missing_ok=True)
        except OSError as err:
            _LOGGER.warning("Could not record the log switch: %s", err)

    def note(self, side: str, source: str, detail: str) -> None:
        """One event. Never raises: a broken log must not break the video."""
        if not self.enabled:
            return
        self._hold(self.line(time.monotonic() - self.started, side, source, detail))

    def _hold(self, line: str) -> None:
        """Keep a line for the writer, which runs off the event loop.

        Writing it here is a disk round trip inside the loop, and this is called
        per channel per announcement with a wall running — Home Assistant
        detects it and says so, correctly. Every line carries its own timestamp
        and the file is sorted when it is read, so time spent in memory costs
        nothing at all.

        There is no timer. While a write is in flight the lines behind it simply
        gather, and the writer takes whatever has arrived on its next pass: busy
        periods coalesce into fewer, larger writes and a quiet one goes out at
        once. Nothing to cancel when Home Assistant stops, either.
        """
        self._pending.append(line)
        if self._writing:
            return
        self._writing = True
        self.hass.async_create_background_task(self._drain(), name="xmeye-debuglog")

    async def _drain(self) -> None:
        try:
            while self._pending:
                batch, self._pending = self._pending, []
                await self.hass.async_add_executor_job(self._write, batch)
        finally:
            self._writing = False

    def note_client(
        self, entries: list[dict], client_now: float = 0.0, client: str = ""
    ) -> None:
        """A batch shipped by the panel, placed on this file's clock.

        The browser times events against its own page load, which is not this
        file's origin and may not even be this machine's clock — the panel is
        often open on a phone. So each batch says what time it thinks it is as it
        sends, and everything in it is shifted by the difference. What is left
        over is the network hop, which on a house network is a millisecond and
        well under the events being ordered.
        """
        if not self.enabled:
            return
        skew = (time.time() - client_now / 1000) if client_now else 0.0
        # Several browsers can be recording at once — which is the whole point
        # when a fault happens in one of them — so each says which it is.
        side = f"web:{client[:4]}" if client else "web"
        lines = [
            self.line(
                float(entry.get("epoch", 0.0)) / 1000 + skew - self.started_epoch,
                side,
                str(entry.get("event", ""))[:40],
                str(entry.get("detail", ""))[:400],
            )
            for entry in entries[:400]
        ]
        self._write(lines)

    @staticmethod
    def line(at: float, side: str, source: str, detail: str) -> str:
        return f"{at:8.3f} {side:<9} {source:<12} {detail}"

    def read_in_order(self) -> str:
        """The file sorted by its own clock.

        Appending puts the browser's lines wherever its batch happened to
        arrive, up to a couple of seconds late. Every line carries a comparable
        timestamp, so the true order is a sort away — and order is the entire
        reason the two sides share a file.
        """
        if not self.path.exists():
            return ""
        lines = self.path.read_text(encoding="utf-8").splitlines()

        def when(line: str) -> float:
            try:
                return float(line[:8])
            except ValueError:
                return float("-inf")  # the "log opened" banner stays on top

        return "\n".join(sorted(lines, key=when))

    def _write(self, lines: list[str]) -> None:
        """The only place that touches the disk, and never from the loop.

        Reached either from :meth:`_drain`'s executor job or from
        :meth:`note_client`, which the view already hands to an executor.
        """
        try:
            if self.path.exists() and self.path.stat().st_size > MAX_BYTES:
                self.path.replace(self.path.with_suffix(".log.1"))
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write("\n".join(lines) + "\n")
        except OSError as err:
            # Losing the log is a nuisance; losing the stream because of it is a
            # fault, so this stays swallowed and only says so once.
            _LOGGER.warning("Could not write %s: %s", self.path, err)
            self.enabled = False


def get(hass: HomeAssistant) -> DebugLog:
    log = hass.data.get(STORE)
    if log is None:
        log = DebugLog(hass)
        hass.data[STORE] = log
    return log


def note(hass: HomeAssistant, source: str, detail: str) -> None:
    """Shorthand for the server side, which is most of the callers."""
    get(hass).note("back", source, detail)
