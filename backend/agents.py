from agents import Agent
from agents.voice import (
    SingleAgentVoiceWorkflow,
    VoicePipeline,
)
from agents.extensions.handoff_prompt import prompt_with_handoff_instructions

# Create the agent with voice capabilities
agent = Agent(
    name="Voice Assistant",
    instructions=prompt_with_handoff_instructions(
        "You are a helpful voice assistant. Process the audio input and provide relevant responses."
    ),
    model="gpt-4-turbo-preview",
    tools=[],
)

# Create the voice pipeline
pipeline = VoicePipeline(workflow=SingleAgentVoiceWorkflow(agent))
