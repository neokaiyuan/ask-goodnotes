from agents import Agent, FileSearchTool, WebSearchTool
from agents.voice import (
    SingleAgentVoiceWorkflow,
    SingleAgentWorkflowCallbacks,
    VoicePipeline,
)
from agents.extensions.handoff_prompt import prompt_with_handoff_instructions


class YieldTranscriptionCallback(SingleAgentWorkflowCallbacks):
    def on_run(self, workflow: SingleAgentVoiceWorkflow, transcription: str) -> None:
        print(f"Input transcription: {transcription}")
        workflow.input_transcription = transcription


def init_pipeline():
    web_search_agent = Agent(
        name="Web Search Agent",
        model="gpt-4o-mini",
        instructions="You are a helpful assistant that can search the web for information.",
        tools=[WebSearchTool()],
    )

    file_search_agent = Agent(
        name="File Search Agent",
        model="gpt-4o-mini",
        instructions="You are a helpful assistant that can search a user's files for information.",
        tools=[
            FileSearchTool(vector_store_ids=["vs_67ea5f2bb09081919a8b33ee8014870b"])
        ],
    )

    voice_assistant = Agent(
        name="Voice Assistant",
        model="gpt-4o-mini",
        instructions=prompt_with_handoff_instructions(
            """
            You are a helpful voice assistant that tries to answer a user's questions. Keep responses concise.
            For questions about the user's files, use the file search agent.
            For questions about general information that may not be in the user's files, use the web search agent.
            Tell the user whether the information came from the web or their files.
            """
        ),
        handoffs=[file_search_agent, web_search_agent],
    )

    return VoicePipeline(
        workflow=SingleAgentVoiceWorkflow(voice_assistant, YieldTranscriptionCallback())
    )
