"""Entry point: python3 -m fleet_agent"""

from .util.log import setup_logging
from .manager import FleetAgent


def main():
    setup_logging()
    agent = FleetAgent()
    agent.run()


if __name__ == '__main__':
    main()
