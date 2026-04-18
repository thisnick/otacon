import logging
import os
import time

from ..util.adb import adb, adb_shell

log = logging.getLogger('fleet-agent')

JAR_PATH = '/opt/snapshot-server.jar'


def start_snapshot_server(serial: str):
    if not os.path.exists(JAR_PATH):
        log.warning(f'[{serial}] {JAR_PATH} not found -- skipping')
        return

    adb(serial, 'push', JAR_PATH, '/data/local/tmp/snapshot-server.jar', timeout=15)
    adb_shell(serial, 'pkill -f snapshot-server.jar')
    time.sleep(1)
    adb_shell(
        serial,
        'nohup app_process -Djava.class.path=/data/local/tmp/snapshot-server.jar '
        '/ com.otacon.snapshot.SnapshotServer > /dev/null 2>&1 &'
    )
    log.info(f'[{serial}] Snapshot server started')


def setup_port_forwards(serial: str, snapshot_port: int, internal_port: int):
    adb(serial, 'forward', f'tcp:{snapshot_port}', 'tcp:9091')
    adb(serial, 'reverse', f'tcp:{internal_port}', f'tcp:{internal_port}')
    log.info(f'[{serial}] Port forwards: snapshot={snapshot_port}, internal={internal_port}')
