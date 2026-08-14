"""In-process acceleration for the durable Channels activity journal."""

from asyncio import Queue
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class EventFrame:
    sequence: int
    type: str
    channel_id: str
    turn_id: str | None
    payload: dict[str, Any]


class EventBus:
    def __init__(self) -> None:
        self._subscribers: set[Queue[EventFrame]] = set()

    def subscribe(self) -> Queue[EventFrame]:
        queue: Queue[EventFrame] = Queue()
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: Queue[EventFrame]) -> None:
        self._subscribers.discard(queue)

    def publish(self, frame: EventFrame) -> None:
        for queue in tuple(self._subscribers):
            queue.put_nowait(frame)
