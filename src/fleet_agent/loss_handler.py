"""Handles permanent phone/dongle loss — auto-reassign with non-reclaiming policy.

When a phone or dongle has been absent for longer than LOSS_TIMEOUT_SECONDS,
its counterpart is freed or reassigned. If the original hardware later returns,
it joins the spare pool as new — it does NOT reclaim its old slot.
"""

import logging
import threading

from .registry.client import emit_event
from .bluetooth.dongle import save_dongle_assignment, load_dongle_assignments

log = logging.getLogger('fleet-agent')

LOSS_TIMEOUT_SECONDS = 300  # 5 minutes


def handle_phone_lost(serial: str, fleet_agent) -> None:
    """Phone disappeared permanently. Free its assigned dongle back to spare pool.

    The PhoneAgent is typically already removed from self.agents by the
    DISCONNECT_GRACE cleanup (~6s after disconnect). This handler fires
    after the 5-min loss timeout, so we look up the dongle assignment
    from the dongle assignments cache rather than the (already gone) agent.

    Steps:
    1. Stop the PhoneAgent if still present (rare edge case)
    2. Look up dongle assignment from cache
    3. Free the dongle assignment so it returns to spare pool
    4. Emit phone.lost event to registry
    """

    # If agent is somehow still present, stop it
    with fleet_agent._lock:
        entry = fleet_agent.agents.pop(serial, None)

    if entry:
        agent, thread = entry
        agent.stop()
        fleet_agent.port_allocator.release(agent.snapshot_port)

    # Look up the dongle that was assigned to this phone from the cache
    # (works even after the agent has been removed from self.agents)
    assignments = load_dongle_assignments()
    adapter_mac = assignments.get(serial)

    # Free the dongle back to spare pool
    if adapter_mac:
        fleet_agent.port_allocator.release_dongle(adapter_mac)
        log.info(f'Released dongle {adapter_mac} (was assigned to lost phone {serial})')

    emit_event('phone.lost', {
        'serial': serial,
        'phone_id': None,
        'adapter_mac': adapter_mac,
    })
    log.info(f'Phone {serial} marked as lost — dongle freed to spare pool')


def handle_dongle_lost(adapter_mac: str, fleet_agent) -> None:
    """Dongle disappeared permanently. Reassign orphaned phone to a spare dongle.

    Steps:
    1. Find which phone was using this dongle
    2. Claim a spare dongle from the pool
    3. Update the phone's adapter_mac and trigger re-pair
    4. Emit dongle.lost + phone.reassigned events
    """

    # Find the phone that was using this dongle
    orphan_serial = None
    orphan_agent = None
    with fleet_agent._lock:
        for serial, (agent, _) in fleet_agent.agents.items():
            if agent.adapter_mac and agent.adapter_mac.upper() == adapter_mac.upper():
                orphan_serial = serial
                orphan_agent = agent
                break

    if not orphan_serial or not orphan_agent:
        log.warning(f'handle_dongle_lost({adapter_mac}): no phone was using this dongle')
        emit_event('dongle.lost', {
            'adapter_mac': adapter_mac,
            'orphan_serial': None,
        })
        return

    phone_id = orphan_agent.phone_id or orphan_agent.registry_id

    emit_event('dongle.lost', {
        'adapter_mac': adapter_mac,
        'orphan_serial': orphan_serial,
        'phone_id': phone_id,
    })

    # Try to claim a spare dongle
    new_mac = fleet_agent.port_allocator.claim_spare_dongle(orphan_serial)
    if not new_mac:
        log.error(f'No spare dongle available to reassign phone {orphan_serial}')
        return

    # Update the phone agent's adapter_mac
    old_mac = orphan_agent.adapter_mac
    orphan_agent.adapter_mac = new_mac
    orphan_agent.phone_bt_mac = None  # will be set during re-pair

    # Persist the new assignment
    save_dongle_assignment(orphan_serial, new_mac)

    # Trigger re-pair on the new dongle by running the bt_bonded heal
    log.info(f'Reassigning phone {orphan_serial} from dongle {old_mac} to {new_mac}')
    try:
        orphan_agent._run_heal('bt_bonded')
    except Exception as e:
        log.error(f'Re-pair failed after dongle reassignment: {e}')

    emit_event('phone.reassigned', {
        'serial': orphan_serial,
        'phone_id': phone_id,
        'old_adapter_mac': old_mac,
        'new_adapter_mac': new_mac,
    })
    log.info(f'Phone {orphan_serial} reassigned to dongle {new_mac}')
