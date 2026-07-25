import { runAgent } from './agent-loop.ts'
import type {
    ConversationMessage,
    ModelTransport,
    RunBudget,
    RunEventObserver,
    SessionMessage,
    SessionState,
    SystemMessage,
} from './run.ts'

export type ConversationState = {
    readonly workspaceRoot: string
    readonly model: string | null
    messages: [SystemMessage, ...ConversationMessage[]]
}

export type ConversationTurnResult = {
    session: SessionState
    messages: ConversationMessage[]
}

export type CreateConversationOptions = {
    systemPrompt: string
    workspaceRoot: string
    model: string | null
}

export type RunConversationTurnOptions = {
    conversation: ConversationState
    task: string
    budget: RunBudget
    transport: ModelTransport
    onEvent?: RunEventObserver
}

export type RunConversationTurnResult = {
    conversation: ConversationState
    turn: ConversationTurnResult
}

const cloneMessages = <Message extends SessionMessage>(messages: readonly Message[]): Message[] => [
    ...structuredClone(messages),
]

const isConversationMessage = (message: SessionMessage): message is ConversationMessage =>
    message.role !== 'system'

const appendToTranscript = (
    systemMessage: SystemMessage,
    existingMessages: readonly ConversationMessage[],
    turnMessages: readonly ConversationMessage[]
): [SystemMessage, ...ConversationMessage[]] => [
    structuredClone(systemMessage),
    ...cloneMessages(existingMessages),
    ...cloneMessages(turnMessages),
]

export const createConversation = ({
    systemPrompt,
    workspaceRoot,
    model,
}: CreateConversationOptions): ConversationState => ({
    workspaceRoot,
    model,
    messages: [
        {
            role: 'system',
            content: systemPrompt,
        },
    ],
})

export const createConversationTurnResult = (session: SessionState): ConversationTurnResult => ({
    session,
    messages: cloneMessages(session.messages.filter(isConversationMessage)),
})

const createTurnResultFromSuffix = (
    session: SessionState,
    startIndex: number
): ConversationTurnResult => ({
    session,
    messages: cloneMessages(session.messages.slice(startIndex).filter(isConversationMessage)),
})

export const appendTurnToConversation = (
    conversation: ConversationState,
    turn: ConversationTurnResult
): ConversationState => {
    const [systemMessage, ...existingMessages] = conversation.messages

    return {
        workspaceRoot: conversation.workspaceRoot,
        model: conversation.model,
        messages: appendToTranscript(systemMessage, existingMessages, turn.messages),
    }
}

export const runConversationTurn = async ({
    conversation,
    task,
    budget,
    transport,
    onEvent,
}: RunConversationTurnOptions): Promise<RunConversationTurnResult> => {
    const session = await runAgent({
        task,
        workspaceRoot: conversation.workspaceRoot,
        budget,
        model: conversation.model,
        transport,
        initialMessages: conversation.messages,
        ...(onEvent === undefined ? {} : { onEvent }),
    })
    const turn = createTurnResultFromSuffix(session, conversation.messages.length)

    return {
        conversation: appendTurnToConversation(conversation, turn),
        turn,
    }
}
