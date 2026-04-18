import logging

def setup_logging():
    logging.basicConfig(
        format='%(asctime)s fleet-agent: %(message)s',
        datefmt='%H:%M:%S',
        level=logging.INFO,
    )
    return logging.getLogger('fleet-agent')
