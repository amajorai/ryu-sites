export const errorMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : "The operation failed";
export const completeWithModel = (input: {
	prompt: string;
	system: string;
}) => {
	if (!window.ryu?.model?.complete) {
		return Promise.reject(new Error("Connect a Ryu model to edit with chat."));
	}
	return window.ryu.model.complete(input);
};
